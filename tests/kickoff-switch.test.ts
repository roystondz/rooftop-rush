import { describe, expect, it } from 'vitest';
import { Bot, BOT_SKILLS } from '../shared/bot';
import { DT, MATCH, PITCH, PLAYER } from '../shared/constants';
import { autoSwitch, autoSwitchDefending, switchToNearest, SwitchTimer } from '../shared/control';
import { Predictor } from '../shared/prediction';
import { makeSnapshot } from '../shared/protocol';
import { createWorld, step } from '../shared/sim';
import type { Input, World } from '../shared/types';

const idle: Input = { moveX: 0, moveZ: 0, sprint: false, shoot: false, pass: false, tackle: false };
const KICKER = 0; // team 0's attacker kicks off first

/** Runs the kickoff countdown until the whistle. */
function afterWhistle(): World {
  const w = createWorld();
  for (let i = 0; i < Math.ceil(MATCH.kickoffDelay / DT) + 1; i++) step(w, []);
  expect(w.phase).toBe('playing');
  return w;
}

const only = (id: number, input: Input) => {
  const inputs: Input[] = [];
  inputs[id] = input;
  return inputs;
};

describe('kickoff', () => {
  it('gives the kicker the ball at the whistle', () => {
    const w = afterWhistle();
    expect(w.ball.owner).toBe(KICKER);
    expect(w.kickoffPending).toBe(true);
  });

  it("won't let the kicker dribble or shoot, only turn on the spot", () => {
    const w = afterWhistle();
    const k = w.players[KICKER];
    const x = k.x;
    for (let i = 0; i < 30; i++) step(w, only(KICKER, { ...idle, moveZ: 1, sprint: true, shoot: i < 20 }));
    expect(k.x).toBe(x);
    expect(k.z).toBe(0);
    expect(w.ball.owner).toBe(KICKER); // the shot never happened
    expect(k.facing).toBeCloseTo(Math.PI / 2, 1); // but they did turn to face +z
  });

  it('starts play once the kicker passes to a teammate', () => {
    const w = afterWhistle();
    step(w, only(KICKER, { ...idle, pass: true }));
    expect(w.kickoffPending).toBe(false);
    expect(w.ball.lastKick.kind).toBe('pass');
    const target = w.players[w.ball.lastKick.target];
    expect(target.team).toBe(0);
  });

  it('keeps the other team out of the centre circle until the pass', () => {
    const w = afterWhistle();
    const striker = w.players[3]; // team 1's attacker, running straight at the ball
    for (let i = 0; i < 60; i++) step(w, only(3, { ...idle, moveX: -1, sprint: true }));
    expect(Math.hypot(striker.x, striker.z)).toBeGreaterThanOrEqual(PITCH.centreCircle + PLAYER.radius - 1e-9);
    expect(w.ball.owner).toBe(KICKER);
  });

  it('passes for you if you wait too long', () => {
    const w = afterWhistle();
    for (let i = 0; i < Math.ceil(MATCH.kickoffPassTime / DT) + 2; i++) step(w, []);
    expect(w.kickoffPending).toBe(false);
    expect(w.ball.lastKick.kind === 'pass' || w.ball.owner !== KICKER).toBe(true);
  });

  it('bots kick off with a pass too', () => {
    const w = afterWhistle();
    const bots = w.players.map((p) => new Bot(p.id, BOT_SKILLS.normal));
    let passed = false;
    for (let i = 0; i < 90 && !passed; i++) {
      step(w, bots.map((b) => b.think(w)));
      passed = w.events.some((e) => e.type === 'pass' && e.player === KICKER);
    }
    expect(passed).toBe(true);
  });

  it('hands control back to your attacker at every kickoff', () => {
    const w = createWorld();
    const controlled = [2, -1]; // e.g. you were on your keeper when the goal went in
    w.events = [{ type: 'kickoff', team: 1 }];
    autoSwitch(w, controlled, w.events);
    expect(controlled[0]).toBe(KICKER);
  });

  it('the predictor keeps the kicker still too', () => {
    const w = afterWhistle();
    const pred = new Predictor();
    pred.reconcile(makeSnapshot(w, [KICKER, -1], []), 0, KICKER);
    for (let seq = 1; seq <= 20; seq++) pred.addInput(seq, { ...idle, moveX: 1 });
    expect(pred.state.x).toBe(w.players[KICKER].x);
  });
});

describe('switching while defending', () => {
  /** Team 1 has the ball near our midfielder (id 1); you control the attacker (id 0), far away. */
  function defending(): { w: World; controlled: number[]; timer: SwitchTimer } {
    const w = createWorld();
    Object.assign(w, { phase: 'playing', kickoffPending: false, tick: 1000 });
    Object.assign(w.players[0], { x: 12, z: 8 });
    Object.assign(w.players[1], { x: -6, z: -2 });
    Object.assign(w.players[3], { x: -5, z: 0 });
    Object.assign(w.ball, { x: -4.1, z: 0, owner: 3 });
    return { w, controlled: [0, -1], timer: new SwitchTimer() };
  }

  it('switches to the teammate much closer to the ball', () => {
    const { w, controlled, timer } = defending();
    const change = autoSwitchDefending(w, controlled, 0, timer);
    expect(change).toEqual({ from: 0, to: 1 });
    expect(controlled[0]).toBe(1);
  });

  it("doesn't switch when you are already close enough to go for it", () => {
    const { w, controlled, timer } = defending();
    Object.assign(w.players[0], { x: -1, z: 1 });
    expect(autoSwitchDefending(w, controlled, 0, timer)).toBeNull();
  });

  it("doesn't switch while your team has the ball", () => {
    const { w, controlled, timer } = defending();
    w.ball.owner = 1;
    expect(autoSwitchDefending(w, controlled, 0, timer)).toBeNull();
  });

  it('keeps you on the receiver while your pass is travelling', () => {
    const w = afterWhistle();
    const controlled = [KICKER, -1];
    const timer = new SwitchTimer();
    step(w, only(KICKER, { ...idle, pass: true }));
    autoSwitch(w, controlled, w.events, timer);
    const receiver = controlled[0];
    expect(receiver).not.toBe(KICKER);
    // Same tick and the following ones: the loose ball is ours, so no snapping back to the passer.
    for (let i = 0; i < 20; i++) {
      expect(autoSwitchDefending(w, controlled, 0, timer)).toBeNull();
      step(w, []);
      autoSwitch(w, controlled, w.events, timer);
    }
    expect(controlled[0]).toBe(receiver);
  });

  it("waits a moment after a manual switch, so it doesn't fight you", () => {
    const { w, controlled, timer } = defending();
    controlled[0] = 1;
    switchToNearest(w, controlled, 0, timer); // you pressed Q and went back to the far player
    expect(controlled[0]).toBe(0);
    expect(autoSwitchDefending(w, controlled, 0, timer)).toBeNull();
    w.tick += 60;
    expect(autoSwitchDefending(w, controlled, 0, timer)).not.toBeNull();
  });
});
