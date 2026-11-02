// Lob passes and chip shots versus their normal, along-the-ground versions.
import { describe, expect, it } from 'vitest';
import { Bot, BOT_SKILLS } from '../shared/bot';
import { BALL, DT, PITCH, PLAYER } from '../shared/constants';
import { createWorld, penaltyDuel, step } from '../shared/sim';
import type { Input, MatchEvent, World } from '../shared/types';

const idle: Input = { moveX: 0, moveZ: 0, sprint: false, shoot: false, pass: false, tackle: false };
const HALF_L = PITCH.length / 2;

/** Player 0 (team 0, attacking +x) has the ball at (x, z); everyone else parked far away. */
function withBall(x = 0, z = 0): World {
  const w = createWorld();
  Object.assign(w, { phase: 'playing', kickoffPending: false });
  w.players.forEach((p, i) => Object.assign(p, { x: -18 + i * 1.5, z: 11, vx: 0, vz: 0 }));
  Object.assign(w.players[0], { x, z, facing: 0 });
  Object.assign(w.ball, { x: x + 0.9, y: BALL.radius, z, vx: 0, vy: 0, vz: 0, owner: 0 });
  return w;
}

/** Steps with only player 0's inputs (one list per tick), recording the ball's highest point. */
function run(w: World, ticks: number, input: (t: number) => Input = () => idle) {
  let top = 0;
  const events: MatchEvent[] = [];
  for (let t = 0; t < ticks; t++) {
    step(w, [input(t)]);
    top = Math.max(top, w.ball.y);
    events.push(...w.events);
  }
  return { top, events };
}

describe('passes', () => {
  it('a normal pass stays on the ground, even a long one', () => {
    const w = withBall(-10, 0);
    Object.assign(w.players[1], { x: 10, z: 0 });
    const { top } = run(w, 90, (t) => ({ ...idle, pass: t === 0 }));
    expect(top).toBeLessThan(1);
  });

  it('a lob pass goes over a defender in the way and drops to the teammate', () => {
    const lobbed = withBall(-6, 0);
    Object.assign(lobbed.players[1], { x: 7, z: 0 });
    Object.assign(lobbed.players[4], { x: 0.5, z: 0 }); // an opponent right in the passing lane
    const { top, events } = run(lobbed, 120, (t) => ({ ...idle, pass: t === 0, lob: t === 0 }));
    expect(top).toBeGreaterThan(2.2);
    const firstTouch = events.find((e) => e.type === 'possession');
    expect(firstTouch?.player).toBe(1); // the teammate, not the defender

    const along = withBall(-6, 0);
    Object.assign(along.players[1], { x: 7, z: 0 });
    Object.assign(along.players[4], { x: 0.5, z: 0 });
    const ground = run(along, 120, (t) => ({ ...idle, pass: t === 0 }));
    expect(ground.events.find((e) => e.type === 'possession')?.player).toBe(4); // cut out
  });

  it('a lofted through ball drops into the space ahead of the runner', () => {
    const w = withBall(-8, 0);
    Object.assign(w.players[1], { x: -2, z: -5, vx: 6 });
    step(w, [{ ...idle, through: true, lob: true }]);
    expect(w.ball.lastKick).toMatchObject({ kind: 'pass', target: 1, style: 'lob' });
    // Land point: where the ball first comes down.
    let landX = NaN;
    for (let t = 0; t < 120 && Number.isNaN(landX); t++) {
      step(w, []);
      if (w.ball.y <= BALL.radius + 0.01) landX = w.ball.x;
    }
    expect(landX).toBeGreaterThan(4); // well ahead of where the runner started
  });
});

describe('shots', () => {
  const chargeTicks = (c: number) => Math.round((c * PLAYER.maxCharge) / DT);
  const shot = (c: number, chip: boolean) => (t: number): Input => ({ ...idle, shoot: t < chargeTicks(c), lob: chip });

  it('a chip goes higher and slower than a normal shot with the same charge', () => {
    const chip = withBall(0, 0);
    const normal = withBall(0, 0);
    const n = chargeTicks(0.6);
    run(chip, n + 1, shot(0.6, true));
    run(normal, n + 1, shot(0.6, false));
    expect(chip.ball.lastKick.style).toBe('chip');
    expect(chip.ball.vy).toBeGreaterThan(normal.ball.vy + 3);
    expect(Math.hypot(chip.ball.vx, chip.ball.vz)).toBeLessThan(Math.hypot(normal.ball.vx, normal.ball.vz));
  });

  it('the charge decides how far a chip goes', () => {
    const landing = (c: number) => {
      const w = withBall(-15, 0);
      for (let t = 0; t < 200; t++) {
        step(w, [shot(c, true)(t)]);
        if (t > chargeTicks(c) + 3 && w.ball.y <= BALL.radius + 0.01) return w.ball.x;
      }
      return NaN;
    };
    const soft = landing(0.1);
    const firm = landing(0.9);
    expect(firm - soft).toBeGreaterThan(6);
  });

  it('a chip beats a keeper off their line who would save a normal shot', () => {
    const play = (chip: boolean) => {
      const w = withBall(HALF_L - 12, 0);
      const keeper = w.players[5];
      Object.assign(keeper, { x: HALF_L - 6, z: 0, facing: Math.PI }); // rushed out at you
      // Charge so the chip comes down around the goal line.
      const c = chip ? 0.62 : 0.6;
      const { events } = run(w, 200, (t) => ({ ...idle, shoot: t < chargeTicks(c), lob: chip }));
      return events.some((e) => e.type === 'goal') ? 'goal' : events.some((e) => e.type === 'save') ? 'save' : 'other';
    };
    expect(play(false)).toBe('save');
    expect(play(true)).toBe('goal');
  });

  it('a soft chip from the penalty spot (a Panenka) floats in under the bar as the keeper dives', () => {
    const w = createWorld({ mode: 'penalties' });
    for (let i = 0; i < 300 && w.phase !== 'playing'; i++) step(w, []);
    const { taker, keeper } = penaltyDuel(w)!;
    const inputs = (t: number) => {
      const list: Input[] = [];
      list[taker.id] = { ...idle, shoot: t < 3, lob: true };
      list[keeper.id] = { ...idle, moveZ: 1, tackle: t === 4 }; // guesses and dives to one side
      return list;
    };
    let scored = false;
    for (let t = 0; t < 200 && !scored; t++) {
      step(w, inputs(t));
      scored = w.events.some((e) => e.type === 'goal');
    }
    expect(scored).toBe(true);
  });
});

describe('bots', () => {
  it('chip a keeper who has come well off their line, now and then', () => {
    let chips = 0;
    for (let seed = 0; seed < 30; seed++) {
      const w = withBall(HALF_L - 11, 0);
      Object.assign(w.players[5], { x: HALF_L - 5, z: 0 });
      const bot = new Bot(0, BOT_SKILLS.hard, seed);
      for (let t = 0; t < 90; t++) {
        step(w, [bot.think(w)]);
        if (w.events.some((e) => e.type === 'shot' && e.style === 'chip')) {
          chips++;
          break;
        }
      }
    }
    expect(chips).toBeGreaterThan(3);
    expect(chips).toBeLessThan(30);
  });
});
