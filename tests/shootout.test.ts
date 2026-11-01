import { describe, expect, it } from 'vitest';
import { Bot, BOT_SKILLS } from '../shared/bot';
import { DT, PITCH, PLAYER, SHOOTOUT } from '../shared/constants';
import { autoSwitch, startingPlayer } from '../shared/control';
import { createWorld, penaltyDuel, shootoutWinner, step } from '../shared/sim';
import type { Input, World } from '../shared/types';

const idle: Input = { moveX: 0, moveZ: 0, sprint: false, shoot: false, pass: false, tackle: false };

function shootout(): World {
  return createWorld({ mode: 'penalties' });
}

/** Runs the setup pause until the whistle. */
function toWhistle(w: World): void {
  for (let i = 0; i < Math.ceil(SHOOTOUT.setupTime / DT) + 1; i++) step(w, []);
  expect(w.phase).toBe('playing');
}

const only = (id: number, input: Input) => {
  const inputs: Input[] = [];
  inputs[id] = input;
  return inputs;
};

/** Aim (by turning for `aimTicks`), charge for `chargeTicks`, then release. Returns events seen. */
function takeKick(w: World, aim: { moveX: number; moveZ: number }, aimTicks: number, chargeTicks: number, keeper: Input[] = []) {
  const { taker } = penaltyDuel(w)!;
  const seen: string[] = [];
  const run = (input: Input, ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      const inputs = [...keeper];
      inputs[taker.id] = input;
      step(w, inputs);
      seen.push(...w.events.map((e) => e.type));
    }
  };
  run({ ...idle, ...aim }, aimTicks);
  run({ ...idle, shoot: true }, chargeTicks);
  run(idle, 150);
  return seen;
}

describe('penalty shootout: setup', () => {
  it('puts the taker on the spot with the ball, and the other keeper on the line', () => {
    const w = shootout();
    const { taker, keeper } = penaltyDuel(w)!;
    expect(w.mode).toBe('penalties');
    expect(taker.team).toBe(0);
    expect(keeper.team).toBe(1);
    expect(w.ball.owner).toBe(taker.id);
    expect(w.ball.x).toBeCloseTo(PITCH.length / 2 - SHOOTOUT.spotDistance);
    expect(keeper.x).toBeCloseTo(PITCH.length / 2 - 0.6);
    expect(w.phase).toBe('kickoff');
  });

  it("controls whoever is involved: you take your team's kicks and keep for theirs", () => {
    const w = shootout();
    expect(startingPlayer(w, 0)).toBe(penaltyDuel(w)!.taker.id);
    expect(startingPlayer(w, 1)).toBe(penaltyDuel(w)!.keeper.id);
  });
});

describe('penalty shootout: taking a kick', () => {
  it("won't let the taker walk forward or pass, only aim", () => {
    const w = shootout();
    toWhistle(w);
    const { taker } = penaltyDuel(w)!;
    const x = taker.x;
    for (let i = 0; i < 30; i++) step(w, only(taker.id, { ...idle, moveX: 1, moveZ: 1, pass: i === 5 }));
    expect(taker.x).toBe(x);
    expect(w.ball.owner).toBe(taker.id);
    expect(taker.facing).toBeGreaterThan(0.3); // turned toward +z
    expect(taker.facing).toBeLessThanOrEqual(SHOOTOUT.aimLimit + 1e-9);
  });

  it('scores a firm shot into the corner the keeper isn’t covering', () => {
    const w = shootout();
    toWhistle(w);
    const seen = takeKick(w, { moveX: 0.9, moveZ: 0.43 }, 20, 25);
    expect(seen).toContain('goal');
    expect(w.shootout!.kicks[0]).toEqual([1]);
    expect(w.score).toEqual([1, 0]);
  });

  it('is saved when the keeper dives the right way', () => {
    const w = shootout();
    toWhistle(w);
    const { keeper } = penaltyDuel(w)!;
    const keeperInputs: Input[] = [];
    // Shot to the keeper's +z side; the keeper dives that way as it's struck.
    let kicked = false;
    const { taker } = penaltyDuel(w)!;
    for (let i = 0; i < 20; i++) step(w, only(taker.id, { ...idle, moveX: 0.9, moveZ: 0.43 }));
    for (let i = 0; i < 15; i++) step(w, only(taker.id, { ...idle, shoot: true }));
    for (let i = 0; i < 150; i++) {
      const inputs: Input[] = [];
      inputs[keeper.id] = { ...idle, moveZ: 1, tackle: !kicked && w.shootout!.kicked };
      if (w.shootout!.kicked) kicked = true;
      step(w, inputs);
      keeperInputs.length = 0;
    }
    expect(w.shootout!.kicks[0]).toEqual([0]);
    expect(w.score).toEqual([0, 0]);
  });

  it('calls a shot wide as soon as it passes outside the post', () => {
    const w = shootout();
    toWhistle(w);
    let missAt = -1;
    const { taker } = penaltyDuel(w)!;
    for (let i = 0; i < 40; i++) step(w, only(taker.id, { ...idle, moveX: 0.2, moveZ: 1 })); // full turn
    for (let i = 0; i < 20; i++) step(w, only(taker.id, { ...idle, shoot: true, moveZ: 1 })); // curling away
    for (let i = 0; i < 150 && missAt < 0; i++) {
      step(w, []);
      if (w.events.some((e) => e.type === 'penaltyMiss' || e.type === 'save' || e.type === 'goal')) missAt = i;
    }
    expect(w.shootout!.kicks[0]).toEqual([0]);
    expect(missAt).toBeGreaterThan(0);
    expect(missAt).toBeLessThan(60); // within a second, not the 2.5 s safety limit
  });

  it('counts a shot that comes back off the wall as a miss', () => {
    const w = shootout();
    toWhistle(w);
    // Full power with a hard sideways curl, aimed at the edge: it won't go in.
    const seen = takeKick(w, { moveX: 0.25, moveZ: 0.97 }, 40, 50);
    expect(w.shootout!.kicks[0]).toEqual([0]);
    expect(seen.includes('penaltyMiss') || seen.includes('save')).toBe(true);
  });

  it('takes the kick for you if you wait too long', () => {
    const w = shootout();
    toWhistle(w);
    for (let i = 0; i < Math.ceil(SHOOTOUT.timeLimit / DT) + 2; i++) step(w, []);
    expect(w.shootout!.kicked || w.shootout!.kicks[0].length === 1).toBe(true);
  });

  it('alternates: after team 0 kicks, team 1 takes the next one', () => {
    const w = shootout();
    toWhistle(w);
    const seen = takeKick(w, { moveX: 0.9, moveZ: 0.43 }, 20, 25);
    for (let i = 0; i < Math.ceil(SHOOTOUT.resultTime / DT) + 2; i++) step(w, []);
    expect(seen).toContain('penaltySetup');
    expect(w.shootout!.taker).toBe(1);
    expect(penaltyDuel(w)!.taker.team).toBe(1);
  });

  it('switches you between taker and keeper at each kick', () => {
    const w = shootout();
    const controlled = [startingPlayer(w, 0), -1];
    w.shootout!.taker = 1;
    w.events = [{ type: 'penaltySetup', team: 1 }];
    autoSwitch(w, controlled, w.events);
    expect(controlled[0]).toBe(penaltyDuel(w)!.keeper.id);
  });
});

describe('penalty shootout: who wins', () => {
  const k = (...xs: number[]) => xs;
  it('is undecided while both can still win', () => {
    expect(shootoutWinner([k(1, 1), k(1, 0)])).toBe(-1);
  });

  it('ends early once one side can’t catch up', () => {
    expect(shootoutWinner([k(1, 1, 1), k(0, 0, 0)])).toBe(0); // 3–0 with two each left
    expect(shootoutWinner([k(0, 0, 0, 0), k(1, 1, 1)])).toBe(1); // 0–3, team 0 has one left
  });

  it('goes to sudden death when level after five each', () => {
    expect(shootoutWinner([k(1, 1, 1, 0, 1), k(1, 1, 0, 1, 1)])).toBe(-1);
    expect(shootoutWinner([k(1, 1, 1, 0, 1, 1), k(1, 1, 0, 1, 1)])).toBe(-1); // waits for the reply
    expect(shootoutWinner([k(1, 1, 1, 0, 1, 1), k(1, 1, 0, 1, 1, 0)])).toBe(0);
  });

  it('bots play a whole shootout to a winner', () => {
    const w = shootout();
    const bots = w.players.map((p) => new Bot(p.id, BOT_SKILLS.normal, 5));
    let ticks = 0;
    while (w.phase !== 'fulltime' && ticks < 60 * 60 * 5) {
      step(w, bots.map((b) => b.think(w)));
      ticks++;
    }
    expect(w.phase).toBe('fulltime');
    expect(w.winner).not.toBe(-1);
    const [a, b] = w.shootout!.kicks;
    expect(a.length).toBeGreaterThanOrEqual(3);
    expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(1);
  });

  it('keeps the keeper on the goal line', () => {
    const w = shootout();
    toWhistle(w);
    const { keeper } = penaltyDuel(w)!;
    const x = keeper.x;
    for (let i = 0; i < 60; i++) step(w, only(keeper.id, { ...idle, moveX: -1, moveZ: 1, sprint: true }));
    expect(keeper.x).toBe(x);
    expect(keeper.z).toBeLessThanOrEqual(PITCH.goalWidth / 2 + 0.5 + 1e-9);
    expect(keeper.z).toBeGreaterThan(1);
    void PLAYER;
  });
});
