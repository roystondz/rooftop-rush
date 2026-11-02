import { describe, expect, it } from 'vitest';
import { ATTEMPTS, holdSpot, judge, runnerInput, setupAttempt, type Attempt } from '../client/training';
import { BALL, DT, PITCH, PLAYER } from '../shared/constants';
import { step } from '../shared/sim';
import { NO_INPUT, type Input, type World } from '../shared/types';

const HALF_L = PITCH.length / 2;

/** Plays an attempt with `you` deciding your input each tick, until it's judged (or 8 s pass). */
function play(world: World, a: Attempt, you: (w: World, tick: number) => Input) {
  for (let t = 0; t < 8 / DT; t++) {
    const inputs: Input[] = world.players.map(() => NO_INPUT);
    inputs[a.you] = you(world, t);
    if (a.runner >= 0) inputs[a.runner] = { ...NO_INPUT, ...runnerInput(world, a) };
    step(world, inputs);
    holdSpot(world, a);
    const o = judge(world, a, world.events);
    if (o.done) return o;
  }
  return null;
}

/** Turn toward an angle (one tick of stick), then hold shoot for `charge` ticks and let go. */
const shootAt = (angle: number, chargeTicks: number, curl = 0) => (_w: World, t: number): Input => {
  const turn = t < 20;
  const lateral = { x: -Math.sin(angle) * curl, z: Math.cos(angle) * curl };
  return {
    ...NO_INPUT,
    moveX: turn ? Math.cos(angle) * 0.2 : lateral.x,
    moveZ: turn ? Math.sin(angle) * 0.2 : lateral.z,
    shoot: t >= 20 && t < 20 + chargeTicks,
  };
};

describe('training setup', () => {
  it('puts you on your spot with the ball, every drill and every ball', () => {
    for (const drill of ['curl', 'power', 'through'] as const) {
      for (let n = 0; n < ATTEMPTS; n++) {
        const { world, attempt } = setupAttempt(drill, n, 7);
        expect(world.phase).toBe('playing');
        expect(world.ball.owner).toBe(attempt.you);
        expect(world.players[attempt.you]).toMatchObject(attempt.spot);
      }
    }
  });

  it('puts a defender on the straight line to each ring for curl, and gives power a keeper', () => {
    const { world, attempt } = setupAttempt('curl', 0, 3);
    expect(attempt.targets).toHaveLength(2);
    attempt.targets.forEach((ring, i) => {
      const d = world.players[3 + i];
      // The defender sits on the line from you to the ring.
      const toRing = Math.atan2(ring.z - attempt.spot.z, ring.x - attempt.spot.x);
      const toDefender = Math.atan2(d.z - attempt.spot.z, d.x - attempt.spot.x);
      expect(Math.abs(toRing - toDefender)).toBeLessThan(0.01);
    });
    expect(setupAttempt('power', 0, 3).attempt.keeper).toBeGreaterThanOrEqual(0);
  });

  it('varies the balls within a drill', () => {
    const spots = new Set(Array.from({ length: ATTEMPTS }, (_, n) => JSON.stringify(setupAttempt('curl', n, 1).attempt.spot)));
    expect(spots.size).toBeGreaterThan(5);
  });

  it('keeps you on your spot until you strike the ball', () => {
    const { world, attempt } = setupAttempt('power', 0, 2);
    const run: Input = { ...NO_INPUT, moveX: 1, sprint: true };
    for (let i = 0; i < 30; i++) {
      step(world, [run]);
      holdSpot(world, attempt);
    }
    expect(world.players[0]).toMatchObject(attempt.spot);
  });
});

describe('judging', () => {
  it('curl: a ball through a ring is a target', () => {
    const { world, attempt } = setupAttempt('curl', 0, 5);
    attempt.struck = true;
    const t = attempt.targets[0];
    Object.assign(world.ball, { owner: -1, x: HALF_L + 0.1, y: t.y, z: t.z });
    attempt.lastX = HALF_L - 0.2;
    expect(judge(world, attempt, [])).toMatchObject({ done: true, success: true });
  });

  it('curl: in the goal but nowhere near a ring does not count', () => {
    const { world, attempt } = setupAttempt('curl', 0, 5);
    attempt.struck = true;
    Object.assign(world.ball, { owner: -1, x: HALF_L + 0.1, y: BALL.radius, z: 0 });
    attempt.lastX = HALF_L - 0.2;
    expect(judge(world, attempt, [])).toMatchObject({ done: true, success: false });
  });

  it('curl: a shot straight at the defender is blocked', () => {
    const { world, attempt } = setupAttempt('curl', 2, 5);
    const wall = world.players[3];
    const angle = Math.atan2(wall.z - attempt.spot.z, wall.x - attempt.spot.x);
    const o = play(world, attempt, shootAt(angle, 10));
    expect(o).toMatchObject({ success: false });
  });

  it('curl: every ball can be put in a ring, going round the defenders', () => {
    for (let n = 0; n < 4; n++) {
      let hit = false;
      for (let off = -0.5; off <= 0.51 && !hit; off += 0.05) {
        for (const charge of [0.5, 0.75, 1]) {
          const { world, attempt } = setupAttempt('curl', n, 11);
          const toGoal = Math.atan2(-attempt.spot.z, HALF_L - attempt.spot.x);
          if (play(world, attempt, shootAt(toGoal + off, Math.round((PLAYER.maxCharge * charge) / DT)))?.success) hit = true;
        }
      }
      expect(hit, `ball ${n}`).toBe(true);
    }
  });

  it('power: reports the speed of each shot', () => {
    const { world, attempt } = setupAttempt('power', 0, 4);
    const o = play(world, attempt, shootAt(Math.atan2(2 - attempt.spot.z, HALF_L - attempt.spot.x), Math.round(PLAYER.maxCharge / DT)));
    expect(o?.done).toBe(true);
    expect(o && o.done && o.detail).toMatch(/^\d+ km\/h$/);
    expect(attempt.speed).toBeGreaterThan(20);
  });

  it('through: a through ball once the runner is past the defenders finds them in the zone', () => {
    let perfect = 0;
    for (let n = 0; n < ATTEMPTS; n++) {
      const { world, attempt } = setupAttempt('through', n, 9);
      const o = play(world, attempt, (_w, t) => ({ ...NO_INPUT, through: t === 70 }));
      if (o?.success) perfect++;
    }
    expect(perfect).toBeGreaterThan(ATTEMPTS / 2);
  });

  it('through: a pass played straight away, before the run, is too short or cut out', () => {
    let failed = 0;
    for (let n = 0; n < ATTEMPTS; n++) {
      const { world, attempt } = setupAttempt('through', n, 9);
      const o = play(world, attempt, (_w, t) => ({ ...NO_INPUT, pass: t === 0 }));
      if (o && !o.success) failed++;
    }
    expect(failed).toBeGreaterThan(ATTEMPTS / 2);
  });
});
