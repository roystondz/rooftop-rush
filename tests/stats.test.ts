import { describe, expect, it } from 'vitest';
import { createWorld } from '../shared/sim';
import type { MatchEvent, Team, World } from '../shared/types';
import { cleanStats, emptyStats, loadStats, recordEvent, recordResult, saveStats, totals } from '../client/stats';

const NAMES: [string, string] = ['SKYLINE', 'NEON'];

function finished(score: [number, number], mode: 'match' | 'penalties' = 'match'): World {
  const w = createWorld({ mode });
  w.score = score;
  w.phase = 'fulltime';
  w.winner = score[0] === score[1] ? -1 : score[0] > score[1] ? 0 : 1;
  return w;
}

describe('stats: results', () => {
  it('records wins, draws and losses against the right opponent', () => {
    const s = emptyStats();
    recordResult(s, finished([3, 1]), 0, 'hard', NAMES);
    recordResult(s, finished([2, 2]), 0, 'hard', NAMES);
    recordResult(s, finished([0, 1]), 0, 'online', NAMES);
    expect(s.matches.hard).toEqual({ played: 2, won: 1, drawn: 1, lost: 0, goalsFor: 5, goalsAgainst: 3 });
    expect(s.matches.online).toMatchObject({ played: 1, lost: 1, goalsFor: 0, goalsAgainst: 1 });
    expect(totals(s)).toMatchObject({ played: 3, won: 1, drawn: 1, lost: 1 });
  });

  it('sees the result from your side when you play for the second team', () => {
    const s = emptyStats();
    const r = recordResult(s, finished([1, 4]), 1, 'online', NAMES);
    expect(r).toMatchObject({ result: 'W', us: 'NEON', them: 'SKYLINE', score: [4, 1] });
    expect(s.biggestWin).toEqual({ margin: 3, line: 'NEON 4–1 SKYLINE' });
  });

  it('keeps shootouts apart from matches', () => {
    const s = emptyStats();
    recordResult(s, finished([4, 3], 'penalties'), 0, 'normal', NAMES);
    expect(s.shootouts.normal).toMatchObject({ played: 1, won: 1, goalsFor: 4, goalsAgainst: 3 });
    expect(s.matches.normal.played).toBe(0);
    expect(s.biggestWin).toBeNull(); // a shootout isn't a "biggest win"
  });

  it('tracks the current and best win streak', () => {
    const s = emptyStats();
    for (const score of [[1, 0], [2, 0], [3, 1], [0, 0], [1, 0]] as [number, number][]) {
      recordResult(s, finished(score), 0, 'easy', NAMES);
    }
    expect(s.bestStreak).toBe(3);
    expect(s.streak).toBe(1);
  });

  it('remembers the ten most recent results, newest first', () => {
    const s = emptyStats();
    for (let i = 0; i < 14; i++) recordResult(s, finished([i, 0]), 0, 'easy', NAMES, i);
    expect(s.recent).toHaveLength(10);
    expect(s.recent[0].score).toEqual([13, 0]);
  });
});

describe('stats: events', () => {
  const goal = (team: Team, player: number, ownGoal = false): MatchEvent => ({ type: 'goal', team, player, ownGoal });

  it('counts only goals scored by the player you control', () => {
    const s = emptyStats();
    const w = createWorld();
    recordEvent(s, w, goal(0, 0), 0, 0); // you
    recordEvent(s, w, goal(0, 1), 0, 0); // a bot teammate
    recordEvent(s, w, goal(1, 0, true), 0, 0); // your own goal
    recordEvent(s, w, goal(1, 3), 0, 0); // the other team
    expect(s.yourGoals).toBe(1);
  });

  it('counts penalties you take and penalties you face in goal', () => {
    const s = emptyStats();
    const w = createWorld({ mode: 'penalties' });
    // Team 0 is taking: you (player 0) shoot.
    recordEvent(s, w, { type: 'goal', team: 0, player: 0 }, 0, 0);
    recordEvent(s, w, { type: 'penaltyMiss', team: 0, player: 0 }, 0, 0);
    // Team 1 is taking against your keeper (player 2).
    w.shootout!.taker = 1;
    recordEvent(s, w, { type: 'penaltyMiss', team: 1, player: 3 }, 0, 2);
    recordEvent(s, w, { type: 'goal', team: 1, player: 3 }, 0, 2);
    expect(s.pens).toEqual({ taken: 2, scored: 1, faced: 2, saved: 1 });
    expect(s.yourGoals).toBe(0); // shootout goals aren't match goals
  });
});

describe('stats: storage', () => {
  it('keeps working when the browser has no storage', () => {
    // Node has no localStorage, like a browser with storage blocked.
    expect(() => saveStats(emptyStats())).not.toThrow();
    expect(loadStats()).toEqual(emptyStats());
  });

  it('survives a round trip through JSON', () => {
    const s = emptyStats();
    recordResult(s, finished([2, 1]), 0, 'normal', NAMES, 1000);
    s.yourGoals = 2;
    expect(cleanStats(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('throws away damaged or tampered values', () => {
    const s = cleanStats({
      matches: { easy: { played: -4, won: 'lots', goalsFor: 2.7 }, bogus: { played: 9 } },
      yourGoals: Infinity,
      pens: null,
      streak: 3,
      bestStreak: 1,
      biggestWin: { margin: 2, line: 42 },
      recent: [{ result: 'X' }, 'nope', { result: 'W', opponent: 'hard', mode: 'match', us: 'A', them: 'B', score: [2, 1], at: 5 }],
    });
    expect(s.matches.easy).toMatchObject({ played: 0, won: 0, goalsFor: 2 });
    expect(s.yourGoals).toBe(0);
    expect(s.pens).toEqual({ taken: 0, scored: 0, faced: 0, saved: 0 });
    expect(s.bestStreak).toBe(3); // never less than the current streak
    expect(s.biggestWin).toBeNull();
    expect(s.recent).toHaveLength(1);
    expect(cleanStats('garbage')).toEqual(emptyStats());
  });
});
