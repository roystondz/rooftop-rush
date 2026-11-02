import { describe, expect, it } from 'vitest';
import { Replay } from '../client/replay';
import { BALL, DT, MATCH, PITCH, REPLAY } from '../shared/constants';
import { createWorld, step } from '../shared/sim';
import type { World } from '../shared/types';

/** Team 0's attacker (id 0) has just hit the ball toward the goal at +x. */
function aboutToScore(): World {
  const w = createWorld();
  w.phase = 'playing';
  w.kickoffPending = false;
  w.players.forEach((p, i) => Object.assign(p, { x: -15 + i * 5, z: 4, vx: 0, vz: 0 }));
  Object.assign(w.players[0], { x: 14, z: -3 });
  Object.assign(w.ball, { x: 15, y: BALL.radius, z: -1, vx: 14, vy: 0, vz: 0, owner: -1, lastTouch: 0 });
  return w;
}

/** Runs ticks until the goal goes in, recording into the replay as the game does. */
function playToGoal(w: World, replay: Replay): number {
  for (let i = 0; i < 120; i++) {
    step(w, []);
    replay.record(w, w.tick * DT);
    if (w.events.some((e) => e.type === 'goal')) return w.tick * DT;
  }
  throw new Error('no goal');
}

describe('goal celebration', () => {
  it('sends the scorer running toward the corner, with a teammate following', () => {
    const w = aboutToScore();
    playToGoal(w, new Replay());
    const scorer = w.players[0];
    const mate = w.players.find((p) => p.team === 0 && p.role === 'midfielder')!;
    const mateStart = Math.hypot(mate.x - scorer.x, mate.z - scorer.z);
    for (let i = 0; i < 90; i++) step(w, []);
    expect(scorer.x).toBeGreaterThan(PITCH.length / 2 - 5);
    expect(scorer.z).toBeLessThan(-PITCH.width / 2 + 5); // the corner on the side they were on
    expect(Math.hypot(mate.x - scorer.x, mate.z - scorer.z)).toBeLessThan(mateStart);
  });

  it('keeps everyone still after an own goal', () => {
    const w = aboutToScore();
    w.ball.lastTouch = w.players.find((p) => p.team === 1 && p.role === 'keeper')!.id;
    playToGoal(w, new Replay());
    for (let i = 0; i < 60; i++) step(w, []);
    for (const p of w.players) expect(Math.hypot(p.vx, p.vz)).toBeLessThan(0.5);
  });
});

describe('instant replay', () => {
  it('starts after the live celebration, shows the build-up, then ends', () => {
    const w = aboutToScore();
    const replay = new Replay();
    const goalAt = playToGoal(w, replay);
    replay.goal(goalAt);
    let shown = 0;
    let first: World | null = null;
    let goalMoments = 0;
    replay.onGoalMoment = () => goalMoments++;
    let t = 0;
    while (t < 12) {
      step(w, []);
      replay.record(w, w.tick * DT);
      const r = replay.update(DT);
      if (r) {
        shown += DT;
        if (!first) {
          first = r;
          expect(t).toBeGreaterThanOrEqual(REPLAY.delay - DT * 2);
          expect(r.phase).toBe('playing');
          expect(r.ball.x).toBeLessThan(PITCH.length / 2); // the ball hasn't gone in yet
        }
      }
      t += DT;
    }
    expect(first).not.toBeNull();
    expect(goalMoments).toBe(1);
    expect(replay.playing).toBe(false);
    expect(shown).toBeGreaterThan(1.5); // slow motion makes it longer than the second of play it shows
  });

  it('fits inside the pause after a goal, so the kickoff never cuts it off', () => {
    const fast = REPLAY.before - REPLAY.slowFrom;
    const slow = (REPLAY.slowFrom + REPLAY.after) / REPLAY.slowSpeed;
    expect(REPLAY.delay + fast + slow).toBeLessThan(MATCH.goalCelebration - 0.2);
  });

  it('can be skipped with a fresh button press, but not one still held from before', () => {
    const w = aboutToScore();
    const replay = new Replay();
    replay.press(true); // shoot still held from the shot that scored
    replay.goal(playToGoal(w, replay));
    for (let i = 0; i < 120; i++) {
      step(w, []);
      replay.record(w, w.tick * DT);
      replay.update(DT);
      replay.press(true);
    }
    expect(replay.playing).toBe(true);
    replay.press(false);
    replay.press(true);
    expect(replay.playing).toBe(false);
    expect(replay.update(DT)).toBeNull();
  });

  it('ignores penalty shootouts', () => {
    const replay = new Replay();
    const w = createWorld({ mode: 'penalties' });
    replay.record(w, 0);
    replay.record(w, 1);
    replay.goal(1);
    for (let i = 0; i < 200; i++) expect(replay.update(DT)).toBeNull();
  });
});

describe('instant replay online', () => {
  it('is not cut short when frames just before the goal already show the goal phase', () => {
    // Online, drawn frames blend toward the next snapshot, so one drawn just before the goal can
    // already carry phase 'goal'. Only a kickoff should stop the replay going further back.
    const w = aboutToScore();
    const replay = new Replay();
    for (let i = 0; i < 180; i++) replay.record({ ...w, phase: i > 170 ? 'goal' : 'playing' }, i * DT);
    replay.goal(175 * DT);
    for (let i = 0; i < Math.ceil(REPLAY.delay / DT); i++) replay.update(DT);
    let shown = 0;
    while (replay.update(DT) && shown < 10) shown += DT;
    expect(shown).toBeGreaterThan(2.5);
  });
});
