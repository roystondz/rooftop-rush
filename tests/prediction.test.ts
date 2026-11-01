import { describe, expect, it } from 'vitest';
import { DT } from '../shared/constants';
import { Predictor } from '../shared/prediction';
import { makeSnapshot, packInput, unpackInput, type Snapshot } from '../shared/protocol';
import { createWorld, step } from '../shared/sim';
import type { Input, World } from '../shared/types';

const idle: Input = { moveX: 0, moveZ: 0, sprint: false, shoot: false, pass: false, tackle: false };
const ME = 0;

/** A match in play with everyone parked out of the way, so nothing bumps our player. */
function openPitch(): World {
  const w = createWorld();
  w.phase = 'playing';
  w.kickoffPending = false;
  w.players.forEach((p, i) => Object.assign(p, { x: -16 + i * 6, z: 10 }));
  Object.assign(w.players[ME], { x: 0, z: 0 });
  Object.assign(w.ball, { x: 15, z: -10 });
  return w;
}

describe('client prediction', () => {
  it('moves your player as soon as you press a key, before the server has seen it', () => {
    const w = openPitch();
    const pred = new Predictor();
    pred.reconcile(makeSnapshot(w, [ME, -1], []), 0, ME);
    for (let seq = 1; seq <= 6; seq++) pred.addInput(seq, { ...idle, moveX: 1 });
    expect(pred.state.x).toBeGreaterThan(0.15); // 0.1 s of accelerating from a standstill
    expect(w.players[ME].x).toBe(0); // the server hasn't moved yet
  });

  it('ends up exactly where the server does, despite 100 ms of delay each way', () => {
    const LAG_TICKS = 6;
    const w = openPitch();
    const pred = new Predictor();
    pred.reconcile(makeSnapshot(w, [ME, -1], []), 0, ME);

    // Messages in flight, each with the tick it arrives on.
    const toServer: { at: number; seq: number; packed: ReturnType<typeof packInput> }[] = [];
    const toClient: { at: number; s: Snapshot; ack: number }[] = [];
    let ack = 0;
    let worstCorrection = 0;

    for (let t = 1; t <= 300; t++) {
      // Client: a wiggly run with bursts of sprint, sent and predicted at once.
      const input: Input =
        t <= 240
          ? { ...idle, moveX: Math.sin(t / 20), moveZ: Math.cos(t / 31), sprint: t % 60 < 30 }
          : idle;
      const packed = packInput(input);
      pred.addInput(t, unpackInput(packed)); // the client predicts with exactly what it sends
      toServer.push({ at: t + LAG_TICKS, seq: t, packed });

      // Server: uses each input on the tick it arrives.
      const arrived = toServer.filter((m) => m.at === t);
      const inputs: Input[] = [];
      for (const m of arrived) {
        inputs[ME] = unpackInput(m.packed);
        ack = m.seq;
      }
      if (arrived.length) step(w, inputs);
      if (t % 2 === 0) toClient.push({ at: t + LAG_TICKS, s: JSON.parse(JSON.stringify(makeSnapshot(w, [ME, -1], []))), ack });

      // Client: reconcile with snapshots as they arrive.
      for (const m of toClient.filter((m) => m.at === t)) {
        pred.reconcile(m.s, m.ack, ME);
        worstCorrection = Math.max(worstCorrection, pred.lastCorrection);
      }
    }
    expect(Math.abs(pred.state.x - w.players[ME].x)).toBeLessThan(0.01);
    expect(Math.abs(pred.state.z - w.players[ME].z)).toBeLessThan(0.01);
    // Only rounding in the snapshot, never a real misprediction.
    expect(worstCorrection).toBeLessThan(0.02);
  });

  it('slides smoothly to the server position when it disagrees', () => {
    const w = openPitch();
    const pred = new Predictor();
    pred.reconcile(makeSnapshot(w, [ME, -1], []), 0, ME);
    w.players[ME].x = 1; // e.g. the server says someone pushed us
    pred.reconcile(makeSnapshot(w, [ME, -1], []), 0, ME);
    expect(pred.state.x).toBe(1);
    expect(pred.visualX).toBeCloseTo(0); // still drawn where it was…
    for (let i = 0; i < 30; i++) pred.decay(DT);
    expect(pred.visualX).toBeCloseTo(1, 1); // …then eased across in half a second
  });

  it('jumps straight there after a big reset like a kickoff', () => {
    const w = openPitch();
    const pred = new Predictor();
    pred.reconcile(makeSnapshot(w, [ME, -1], []), 0, ME);
    w.players[ME].x = -15;
    pred.reconcile(makeSnapshot(w, [ME, -1], []), 0, ME);
    expect(pred.visualX).toBe(-15);
  });

  it("doesn't predict movement while the game is frozen for a kickoff", () => {
    const w = openPitch();
    w.phase = 'kickoff';
    const pred = new Predictor();
    pred.reconcile(makeSnapshot(w, [ME, -1], []), 0, ME);
    for (let seq = 1; seq <= 10; seq++) pred.addInput(seq, { ...idle, moveX: 1 });
    expect(pred.state.x).toBe(0);
  });

  it('starts fresh when you switch to another player', () => {
    const w = openPitch();
    const pred = new Predictor();
    pred.reconcile(makeSnapshot(w, [ME, -1], []), 0, ME);
    pred.reconcile(makeSnapshot(w, [1, -1], []), 0, 1);
    expect(pred.playerId).toBe(1);
    expect(pred.state.x).toBe(w.players[1].x);
    expect(pred.offsetX).toBe(0);
  });
});
