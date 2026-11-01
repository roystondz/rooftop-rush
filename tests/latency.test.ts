import { describe, expect, it } from 'vitest';
import { DT } from '../shared/constants';
import { InterpolationClock, MAX_DELAY_TICKS, MIN_DELAY_TICKS } from '../shared/interp';
import { KickPredictor, Predictor } from '../shared/prediction';
import { makeSnapshot } from '../shared/protocol';
import { createWorld, flyLooseBall, step } from '../shared/sim';
import type { Input, World } from '../shared/types';

const idle: Input = { moveX: 0, moveZ: 0, sprint: false, shoot: false, pass: false, tackle: false };

describe('adaptive smoothing buffer', () => {
  it('shrinks to a small buffer on a steady connection', () => {
    const clock = new InterpolationClock();
    for (let t = 0; t < 600; t++) clock.onSnapshot(t, t * DT * 1000);
    expect(clock.delayTicks).toBeLessThan(MIN_DELAY_TICKS + 0.5); // ≈ 42 ms instead of 100 ms
  });

  it('grows when snapshots arrive unevenly, and stays within limits', () => {
    const clock = new InterpolationClock();
    let now = 0;
    for (let t = 0; t < 600; t++) {
      now += DT * 1000 + (t % 2 ? 25 : -25); // ±25 ms wobble
      clock.onSnapshot(t, now);
    }
    expect(clock.delayTicks).toBeGreaterThan(4);
    expect(clock.delayTicks).toBeLessThanOrEqual(MAX_DELAY_TICKS);
  });

  it('draws steadily behind the newest snapshot', () => {
    const clock = new InterpolationClock();
    let newest = 0;
    for (let f = 0; f < 300; f++) {
      newest++;
      clock.onSnapshot(newest, f * DT * 1000);
      clock.advance(DT, newest);
    }
    const behind = newest - clock.renderTick;
    expect(behind).toBeGreaterThan(MIN_DELAY_TICKS - 0.5);
    expect(behind).toBeLessThan(MIN_DELAY_TICKS + 1.5);
  });
});

/** A match in play, our attacker (id 0) holding the ball in midfield, everyone else far away. */
function onTheBall(): World {
  const w = createWorld();
  w.phase = 'playing';
  w.kickoffPending = false;
  w.players.forEach((p, i) => Object.assign(p, { x: -16 + i * 6, z: 10 }));
  Object.assign(w.players[0], { x: 0, z: 0, facing: 0 });
  Object.assign(w.players[1], { x: 8, z: 0 });
  Object.assign(w.ball, { x: 0.9, z: 0, owner: 0 });
  return w;
}

describe('predicting your own kicks', () => {
  it("shows the shot leaving your foot, on the same path as the server's", () => {
    const server = onTheBall();
    const snap = JSON.parse(JSON.stringify(makeSnapshot(server, [0, -1], [])));
    const pred = new Predictor();
    pred.reconcile(snap, 0, 0);
    const kick = new KickPredictor();

    // Hold shoot for 20 ticks on both sides, then let go.
    let prev = idle;
    for (let i = 0; i < 20; i++) {
      const hold = { ...idle, shoot: true };
      expect(kick.tryKick(snap, pred.state, hold, prev)).toBeNull();
      pred.addInput(i + 1, hold);
      step(server, [hold]);
      prev = hold;
    }
    const kind = kick.tryKick(snap, pred.state, idle, prev);
    expect(kind).toBe('shot');
    step(server, [idle]);
    expect(server.ball.owner).toBe(-1);

    // Both balls fly for half a second and should be in the same place.
    for (let i = 0; i < 30; i++) {
      kick.tick();
      flyLooseBall(server);
    }
    const p = kick.ball;
    expect(Math.hypot(p.x - server.ball.x, p.z - server.ball.z)).toBeLessThan(0.3);
    expect(p.x).toBeGreaterThan(5);
  });

  it('shows a pass immediately', () => {
    const w = onTheBall();
    const snap = makeSnapshot(w, [0, -1], []);
    const pred = new Predictor();
    pred.reconcile(snap, 0, 0);
    const kick = new KickPredictor();
    expect(kick.tryKick(snap, pred.state, { ...idle, pass: true }, idle)).toBe('pass');
    expect(kick.active).toBe(true);
  });

  it("doesn't predict anything when you don't have the ball", () => {
    const w = onTheBall();
    w.ball.owner = 3;
    const snap = makeSnapshot(w, [0, -1], []);
    const pred = new Predictor();
    pred.reconcile(snap, 0, 0);
    expect(new KickPredictor().tryKick(snap, pred.state, { ...idle, pass: true }, idle)).toBeNull();
  });

  it('gives up after a while if the server never confirms', () => {
    const w = onTheBall();
    const snap = makeSnapshot(w, [0, -1], []);
    const pred = new Predictor();
    pred.reconcile(snap, 0, 0);
    const kick = new KickPredictor();
    kick.tryKick(snap, pred.state, { ...idle, pass: true }, idle);
    for (let i = 0; i < 100; i++) kick.tick();
    expect(kick.active).toBe(false);
  });
});
