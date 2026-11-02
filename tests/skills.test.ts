// Skill moves, headers, volleys and crosses.
import { describe, expect, it } from 'vitest';
import { Bot, BOT_SKILLS } from '../shared/bot';
import { BALL, DT, PITCH, PLAYER, SKILL } from '../shared/constants';
import { applySnapshot, makeSnapshot, packInput, unpackInput } from '../shared/protocol';
import { canHead, createWorld, step } from '../shared/sim';
import type { Input, MatchEvent, World } from '../shared/types';

const idle: Input = { moveX: 0, moveZ: 0, sprint: false, shoot: false, pass: false, tackle: false };
const HALF_L = PITCH.length / 2;

/** Open play with everyone parked out of the way; player 0 (team 0, attacking +x) at the centre. */
function openPlay(): World {
  const w = createWorld();
  Object.assign(w, { phase: 'playing', kickoffPending: false });
  w.players.forEach((p, i) => Object.assign(p, { x: -16 + i * 6, z: 10, vx: 0, vz: 0 }));
  Object.assign(w.players[0], { x: 0, z: 0, facing: 0 });
  Object.assign(w.ball, { x: 0.9, y: BALL.radius, z: 0, vx: 0, vy: 0, vz: 0, owner: 0 });
  return w;
}

/** Steps once and returns the events. */
function tick(w: World, inputs: (Input | undefined)[]): MatchEvent[] {
  step(w, inputs);
  return w.events;
}

describe('skill moves', () => {
  it('sidestep: a quick burst sideways, keeping the ball', () => {
    const w = openPlay();
    const events = tick(w, [{ ...idle, moveZ: 1, skill: true }]);
    expect(events.some((e) => e.type === 'skill')).toBe(true);
    expect(w.players[0].vz).toBeGreaterThan(4);
    expect(w.ball.owner).toBe(0);
    expect(w.players[0].skillTimer).toBeGreaterThan(0);
  });

  it('drag-back: pulling back turns you round', () => {
    const w = openPlay();
    tick(w, [{ ...idle, moveX: -1, skill: true }]);
    expect(Math.abs(Math.abs(w.players[0].facing) - Math.PI)).toBeLessThan(0.3);
    expect(w.players[0].vx).toBeLessThan(0);
  });

  it('beats a tackle: the tackler misses and is left off balance', () => {
    const w = openPlay();
    const defender = w.players[3];
    Object.assign(defender, { x: 1.9, z: 0, facing: Math.PI });
    tick(w, [{ ...idle, skill: true }]);
    const inputs: Input[] = [];
    inputs[0] = idle;
    inputs[3] = { ...idle, tackle: true };
    tick(w, inputs);
    expect(w.ball.owner).toBe(0);
    expect(defender.stun).toBeGreaterThan(0);
  });

  it('has a cooldown and costs stamina', () => {
    const w = openPlay();
    const before = w.players[0].stamina;
    tick(w, [{ ...idle, skill: true }]);
    tick(w, [idle]);
    expect(tick(w, [{ ...idle, skill: true }]).some((e) => e.type === 'skill')).toBe(false); // too soon
    expect(w.players[0].stamina).toBeLessThan(before);
    for (let i = 0; i < Math.ceil(SKILL.cooldown / DT); i++) tick(w, [idle]);
    w.players[0].stamina = 1;
    expect(tick(w, [{ ...idle, skill: true }]).some((e) => e.type === 'skill')).toBe(true);
  });

  it('needs the ball', () => {
    const w = openPlay();
    w.ball.owner = -1;
    w.ball.x = 5;
    expect(tick(w, [{ ...idle, skill: true }]).some((e) => e.type === 'skill')).toBe(false);
  });
});

/** A loose ball dropping onto player 0's head. */
function ballAtHead(height = 1.8): World {
  const w = openPlay();
  Object.assign(w.ball, { owner: -1, x: 0.4, y: height, z: 0, vx: -2, vy: -1, vz: 0 });
  return w;
}

describe('headers', () => {
  it('pressing shoot heads it where you point, low and hard', () => {
    const w = ballAtHead();
    const events = tick(w, [{ ...idle, moveX: 1, shoot: true }]);
    const shot = events.find((e) => e.type === 'shot');
    expect(shot?.style).toBe('header');
    expect(w.ball.vx).toBeGreaterThan(SKILL.headerSpeed * 0.9);
    expect(w.ball.vy).toBeLessThan(2);
    expect(w.players[0].jump).toBeGreaterThan(0);
  });

  it('holding shoot as the ball arrives heads it automatically', () => {
    const w = ballAtHead();
    w.players[0].charging = true;
    w.players[0].prevShoot = true;
    expect(tick(w, [{ ...idle, moveX: 1, shoot: true }]).some((e) => e.type === 'shot' && e.style === 'header')).toBe(true);
  });

  it('pressing pass heads it to a teammate', () => {
    const w = ballAtHead();
    Object.assign(w.players[1], { x: 0, z: -8 });
    const pass = tick(w, [{ ...idle, pass: true }]).find((e) => e.type === 'pass');
    expect(pass).toMatchObject({ style: 'header', target: 1 });
    expect(w.ball.vz).toBeLessThan(0);
  });

  it('only at head height and within reach', () => {
    expect(canHead(ballAtHead(0.8), ballAtHead(0.8).players[0])).toBe(false); // too low: that's a volley
    const high = ballAtHead(3.2);
    expect(canHead(high, high.players[0])).toBe(false);
    const far = ballAtHead();
    far.ball.x = 2.5;
    expect(canHead(far, far.players[0])).toBe(false);
  });

  it('a keeper in their box catches instead of heading', () => {
    const w = ballAtHead();
    const keeper = w.players[2]; // team 0's keeper
    Object.assign(keeper, { x: -HALF_L + 2, z: 0 });
    Object.assign(w.ball, { x: -HALF_L + 2.4, z: 0 });
    expect(canHead(w, keeper)).toBe(false);
  });

  it('a headed goal is announced as one', () => {
    const w = openPlay();
    Object.assign(w.players[0], { x: HALF_L - 3, z: 0 });
    Object.assign(w.ball, { owner: -1, x: HALF_L - 2.6, y: 1.7, z: 0, vx: 0, vy: 0, vz: 0 });
    let goal: MatchEvent | undefined;
    for (let i = 0; i < 60 && !goal; i++) {
      goal = tick(w, [i === 0 ? { ...idle, moveX: 1, shoot: true } : idle]).find((e) => e.type === 'goal');
    }
    expect(goal).toMatchObject({ team: 0, player: 0, style: 'header' });
  });
});

describe('volleys', () => {
  it('a first-time shot on a ball in the air is flatter and quicker than one off the ground', () => {
    const strike = (height: number) => {
      const w = openPlay();
      Object.assign(w.ball, { owner: -1, x: 0.8, y: height, z: 0, vx: 0, vy: 0, vz: 0 });
      Object.assign(w.players[0], { charging: true, charge: PLAYER.maxCharge * 0.6, prevShoot: true });
      const shot = tick(w, [idle]).find((e) => e.type === 'shot');
      return { shot, vy: w.ball.vy, speed: Math.hypot(w.ball.vx, w.ball.vz) };
    };
    const volley = strike(0.9);
    const ground = strike(BALL.radius);
    expect(volley.shot?.style).toBe('volley');
    expect(ground.shot?.style).toBeUndefined();
    expect(volley.vy).toBeLessThan(ground.vy);
    expect(volley.speed).toBeGreaterThan(ground.speed);
  });
});

describe('crosses', () => {
  it('a pass from out wide to a teammate in the box is lofted to head height', () => {
    const w = openPlay();
    Object.assign(w.players[0], { x: HALF_L - 8, z: -9, facing: 0 });
    Object.assign(w.ball, { x: HALF_L - 7.1, z: -9, owner: 0 });
    Object.assign(w.players[1], { x: HALF_L - 3, z: 0 });
    tick(w, [{ ...idle, pass: true }]);
    expect(w.ball.vy).toBeCloseTo(SKILL.crossLift - BALL.gravity * DT); // one tick of gravity already
    expect(w.ball.lastKick.target).toBe(1);
    // It comes down at about head height near the teammate.
    let closest = Infinity;
    for (let i = 0; i < 90; i++) {
      tick(w, []);
      if (w.ball.y > SKILL.headerMinHeight && w.ball.y < SKILL.headerMaxHeight) {
        closest = Math.min(closest, Math.hypot(w.ball.x - w.players[1].x, w.ball.z - w.players[1].z));
      }
    }
    expect(closest).toBeLessThan(2);
  });

  it('an ordinary pass in midfield stays low', () => {
    const w = openPlay();
    Object.assign(w.players[1], { x: 6, z: -4 });
    tick(w, [{ ...idle, pass: true }]);
    expect(w.ball.vy).toBeLessThan(SKILL.crossLift);
  });
});

describe('bots', () => {
  it('head a cross that reaches them', () => {
    const w = ballAtHead();
    const bot = new Bot(0, { ...BOT_SKILLS.hard, headerChance: 1 });
    expect(tick(w, [bot.think(w)]).some((e) => e.type === 'shot' && e.style === 'header')).toBe(true);
  });

  it('try a skill move against a defender closing in, now and then', () => {
    let tried = 0;
    for (let seed = 0; seed < 40; seed++) {
      const w = openPlay();
      Object.assign(w.players[3], { x: 1.8, z: 0.3 });
      const bot = new Bot(0, BOT_SKILLS.normal, seed);
      bot.think(w); // first look
      if (bot.think(w).skill) tried++;
      else {
        const again = new Bot(0, BOT_SKILLS.normal, seed);
        if (again.think(w).skill) tried++;
      }
    }
    expect(tried).toBeGreaterThan(3);
    expect(tried).toBeLessThan(40);
  });
});

describe('online', () => {
  it('the skill button and the skill and jump poses travel in packets', () => {
    expect(unpackInput(packInput({ ...idle, skill: true })).skill).toBe(true);
    const w = openPlay();
    w.players[0].skillTimer = 0.2;
    w.players[1].jump = 0.2;
    const copy = createWorld();
    applySnapshot(copy, makeSnapshot(w, [0], []));
    expect(copy.players[0].skillTimer).toBeGreaterThan(0);
    expect(copy.players[1].jump).toBeGreaterThan(0);
    expect(copy.players[2].skillTimer).toBe(0);
  });
});
