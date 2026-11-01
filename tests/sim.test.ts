import { describe, expect, it } from 'vitest';
import { Bot, BOT_SKILLS } from '../shared/bot';
import { BALL, DT, MATCH, PITCH, PLAYER, RUSH } from '../shared/constants';
import { createWorld, step } from '../shared/sim';
import type { Input, World } from '../shared/types';

const idle: Input = { moveX: 0, moveZ: 0, sprint: false, shoot: false, pass: false, tackle: false };

/** A world that has finished its kickoff countdown, with the ball loose at the given spot. */
function playing(ballX = 0, ballZ = 0): World {
  const w = createWorld();
  w.phase = 'playing';
  w.phaseTimer = 0;
  w.kickoffPending = false;
  Object.assign(w.ball, { x: ballX, y: BALL.radius, z: ballZ, vx: 0, vy: 0, vz: 0, owner: -1 });
  // Park everyone far from the action unless a test moves them.
  w.players.forEach((p, i) => Object.assign(p, { x: -15 + i * 6, z: 10, vx: 0, vz: 0 }));
  return w;
}

function run(w: World, ticks: number, inputs: (w: World) => (Input | undefined)[] = () => []): void {
  for (let i = 0; i < ticks; i++) step(w, inputs(w));
}

const allEvents = (w: World, ticks: number, inputs?: (w: World) => (Input | undefined)[]) => {
  const seen: string[] = [];
  for (let i = 0; i < ticks; i++) {
    step(w, inputs ? inputs(w) : []);
    seen.push(...w.events.map((e) => e.type));
  }
  return seen;
};

describe('ball physics', () => {
  it('rolls, slows down and stops', () => {
    const w = playing();
    w.ball.vx = 8;
    run(w, 60);
    expect(w.ball.vx).toBeGreaterThan(0);
    expect(w.ball.vx).toBeLessThan(8);
    run(w, 60 * 8);
    expect(w.ball.vx).toBe(0);
  });

  it('falls under gravity and bounces lower each time', () => {
    const w = playing();
    w.ball.y = 5;
    let peakAfterBounce = 0;
    let bounced = false;
    for (let i = 0; i < 120; i++) {
      step(w, []);
      if (w.events.some((e) => e.type === 'bounce')) bounced = true;
      if (bounced) peakAfterBounce = Math.max(peakAfterBounce, w.ball.y);
    }
    expect(bounced).toBe(true);
    expect(peakAfterBounce).toBeLessThan(5);
    expect(w.ball.y).toBeGreaterThanOrEqual(BALL.radius);
  });

  it('bounces off the side wall of the cage', () => {
    const w = playing(0, 10);
    w.ball.vz = 10;
    const seen = allEvents(w, 30);
    expect(seen).toContain('wall');
    expect(w.ball.vz).toBeLessThan(0);
    expect(Math.abs(w.ball.z)).toBeLessThanOrEqual(PITCH.width / 2);
  });

  it('bounces off the end wall beside the goal', () => {
    const w = playing(18, 8);
    w.ball.vx = 10;
    allEvents(w, 30);
    expect(w.ball.vx).toBeLessThan(0);
    expect(w.score).toEqual([0, 0]);
  });

  it('curls toward the side of the spin', () => {
    const straight = playing(-10, 0);
    straight.ball.vx = 20;
    const curled = playing(-10, 0);
    curled.ball.vx = 20;
    curled.ball.spin = 3;
    run(straight, 40);
    run(curled, 40);
    expect(Math.abs(straight.ball.z)).toBeLessThan(0.01);
    expect(curled.ball.z).toBeGreaterThan(1);
  });
});

describe('goals', () => {
  it('scores when the ball fully crosses the line inside the goal', () => {
    const w = playing(18, 0);
    w.ball.vx = 12;
    const seen = allEvents(w, 30);
    expect(seen).toContain('goal');
    expect(w.score).toEqual([1, 0]);
    expect(w.phase).toBe('goal');
  });

  it('gives the goal to team 1 at the other end', () => {
    const w = playing(-18, 0);
    w.ball.vx = -12;
    run(w, 30);
    expect(w.score).toEqual([0, 1]);
  });

  it('does not score over the crossbar', () => {
    const w = playing(18, 0);
    Object.assign(w.ball, { y: PITCH.goalHeight + 1, vx: 12, vy: 0 });
    // Keep it high by checking only the moment it reaches the line.
    run(w, 12);
    expect(w.score).toEqual([0, 0]);
  });

  it('restarts with a kickoff for the team that conceded', () => {
    const w = playing(18, 0);
    w.ball.vx = 12;
    run(w, 30);
    run(w, Math.ceil(MATCH.goalCelebration / DT) + 2);
    expect(w.phase).toBe('kickoff');
    expect(w.kickoffTeam).toBe(1);
    expect(w.ball.x).toBe(0);
  });
});

describe('players', () => {
  it('moves at walking pace and faster when sprinting', () => {
    const walk = playing();
    const sprint = playing();
    const p0 = walk.players[0];
    const s0 = sprint.players[0];
    run(walk, 60, () => [{ ...idle, moveX: 1 }]);
    run(sprint, 60, () => [{ ...idle, moveX: 1, sprint: true }]);
    expect(p0.vx).toBeCloseTo(PLAYER.speed, 1);
    expect(s0.vx).toBeGreaterThan(p0.vx);
    expect(s0.stamina).toBeLessThan(1);
  });

  it('picks up a loose ball it walks into', () => {
    const w = playing(2, 0);
    Object.assign(w.players[0], { x: 0, z: 0 });
    run(w, 60, () => [{ ...idle, moveX: 1 }]);
    expect(w.ball.owner).toBe(0);
  });

  it('shoots harder the longer shoot is held', () => {
    const shotSpeed = (holdTicks: number) => {
      const w = playing(0.9, 0);
      Object.assign(w.players[0], { x: 0, z: 0 });
      run(w, 2);
      expect(w.ball.owner).toBe(0);
      run(w, holdTicks, () => [{ ...idle, shoot: true }]);
      run(w, 1);
      return Math.hypot(w.ball.vx, w.ball.vz);
    };
    const tap = shotSpeed(1);
    const full = shotSpeed(60);
    expect(tap).toBeGreaterThan(10);
    expect(full).toBeGreaterThan(tap + 8);
  });

  it('passes to a teammate who then controls the ball', () => {
    const w = playing(0.9, 0);
    Object.assign(w.players[0], { x: 0, z: 0 });
    Object.assign(w.players[1], { x: 8, z: 0 });
    run(w, 2);
    let received = false;
    for (let i = 0; i < 120 && !received; i++) {
      step(w, i === 0 ? [{ ...idle, pass: true }] : []);
      received = w.events.some((e) => e.type === 'received');
    }
    expect(received).toBe(true);
    expect(w.ball.owner).toBe(1);
    expect(w.rush[0]).toBe(RUSH.pass);
  });

  it('tackles the ball off an opponent and stuns them', () => {
    const w = playing(0.9, 0);
    Object.assign(w.players[3], { x: 0, z: 0, facing: 0 });
    run(w, 2);
    expect(w.ball.owner).toBe(3);
    Object.assign(w.players[0], { x: 1.2, z: 0.6, facing: Math.PI });
    const inputs: (Input | undefined)[] = [];
    inputs[0] = { ...idle, tackle: true };
    step(w, inputs);
    expect(w.ball.owner).toBe(0);
    expect(w.players[3].stun).toBeGreaterThan(0);
    expect(w.rush[0]).toBe(RUSH.steal);
  });

  it('misses a tackle from behind and leaves the tackler off balance', () => {
    const w = playing(0.9, 0);
    Object.assign(w.players[3], { x: 0, z: 0, facing: 0 });
    run(w, 2);
    expect(w.ball.owner).toBe(3);
    Object.assign(w.players[0], { x: -0.9, z: 0, facing: 0 });
    const inputs: (Input | undefined)[] = [];
    inputs[0] = { ...idle, tackle: true };
    step(w, inputs);
    expect(w.ball.owner).toBe(3);
    expect(w.players[0].stun).toBeGreaterThan(0);
  });

  it('fires a power shot when the Rush meter is full, then empties it', () => {
    const w = playing(0.9, 0);
    Object.assign(w.players[0], { x: 0, z: 0 });
    w.rush[0] = RUSH.max;
    run(w, 2);
    run(w, 10, () => [{ ...idle, shoot: true }]);
    const seen = allEvents(w, 1);
    expect(seen).toContain('powerShot');
    expect(w.ball.power).toBe(true);
    expect(w.rush[0]).toBe(0);
  });
});

describe('match flow', () => {
  it('starts with a kickoff countdown, then a whistle', () => {
    const w = createWorld();
    expect(w.phase).toBe('kickoff');
    const seen = allEvents(w, Math.ceil(MATCH.kickoffDelay / DT) + 1);
    expect(seen).toContain('whistle');
    expect(w.phase).toBe('playing');
  });

  it('ends at full time when someone is ahead', () => {
    const w = playing();
    w.time = 0.5;
    w.score = [2, 1];
    run(w, 60);
    expect(w.phase).toBe('fulltime');
    expect(w.winner).toBe(0);
  });

  it('goes to golden goal when level, and the next goal wins', () => {
    const w = playing(18, 0);
    w.time = 0.1;
    const seen = allEvents(w, 10);
    expect(seen).toContain('goldenGoal');
    expect(w.phase).toBe('playing');
    w.ball.vx = 12;
    run(w, 30);
    run(w, Math.ceil(MATCH.goalCelebration / DT) + 2);
    expect(w.phase).toBe('fulltime');
    expect(w.winner).toBe(0);
  });
});

describe('bots and determinism', () => {
  it('gives identical results for identical inputs', () => {
    const play = () => {
      const w = createWorld({ duration: 30 });
      const bots = w.players.map((p) => new Bot(p.id, BOT_SKILLS.normal, 3));
      run(w, 60 * 20, (w) => bots.map((b) => b.think(w)));
      return JSON.stringify([w.score, w.ball, w.players]);
    };
    expect(play()).toBe(play());
  });

  it('plays a full bot match with no broken numbers and the ball inside the arena', () => {
    const w = createWorld();
    const bots = w.players.map((p) => new Bot(p.id, BOT_SKILLS.normal, 1));
    let ticks = 0;
    while (w.phase !== 'fulltime' && ticks < 60 * 60 * 10) {
      step(w, bots.map((b) => b.think(w)));
      ticks++;
      const b = w.ball;
      expect(Number.isFinite(b.x + b.y + b.z)).toBe(true);
      expect(Math.abs(b.z)).toBeLessThanOrEqual(PITCH.width / 2);
      expect(Math.abs(b.x)).toBeLessThanOrEqual(PITCH.length / 2 + PITCH.goalDepth);
    }
    expect(w.phase).toBe('fulltime');
    expect(w.score[0] + w.score[1]).toBeGreaterThan(0);
  });
});
