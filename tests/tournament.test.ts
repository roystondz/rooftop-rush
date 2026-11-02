import { describe, expect, it } from 'vitest';
import { emptyStats, recordTournament, cleanStats } from '../client/stats';
import {
  YOU,
  cleanTournament,
  finish,
  newTournament,
  nextMatch,
  pairings,
  recordYourMatch,
  simulate,
  status,
  type Tournament,
} from '../client/tournament';
import { DT } from '../shared/constants';
import { mulberry32 } from '../shared/math';
import { createWorld, step } from '../shared/sim';

const you = { name: 'SKYLINE', kit: 2 };

describe('tournament draw', () => {
  it('has you and seven different bot teams, each in its own kit', () => {
    const t = newTournament(you, 42);
    expect(t.entrants).toHaveLength(8);
    expect(t.entrants[0]).toEqual({ ...you, level: 'you' });
    const bots = t.entrants.slice(1);
    expect(new Set(bots.map((e) => e.name)).size).toBe(7);
    expect(new Set(bots.map((e) => e.kit)).size).toBe(7);
  });

  it('starts you against an easy team and keeps both hard teams for the other half', () => {
    for (const seed of [1, 2, 3, 99]) {
      const t = newTournament(you, seed);
      expect(t.entrants[1].level).toBe('easy');
      expect(t.entrants.slice(4).filter((e) => e.level === 'hard')).toHaveLength(2);
    }
  });

  it('draws the teams into different places in different tournaments', () => {
    const names = (seed: number) => newTournament(you, seed).entrants.map((e) => e.name).join();
    expect(new Set([1, 2, 3, 4, 5].map(names)).size).toBeGreaterThan(1);
  });
});

describe('playing through', () => {
  it('goes quarter-final, semi-final, final, and crowns you if you win them all', () => {
    const t = newTournament(you, 7);
    expect(nextMatch(t)).toEqual({ round: 0, opponent: 1 });
    recordYourMatch(t, [3, 1], null);
    expect(t.rounds[0]).toHaveLength(4); // the other quarter-finals were played too
    expect(nextMatch(t)?.round).toBe(1);
    recordYourMatch(t, [1, 1], [4, 3]); // won on penalties
    expect(nextMatch(t)?.round).toBe(2);
    recordYourMatch(t, [2, 0], null);
    expect(status(t)).toBe('champion');
    expect(finish(t)).toBe(3);
    expect(nextMatch(t)).toBeNull();
  });

  it('plays out the rest of the bracket when you are knocked out', () => {
    const t = newTournament(you, 7);
    recordYourMatch(t, [3, 1], null);
    recordYourMatch(t, [0, 2], null);
    expect(status(t)).toBe('out');
    expect(finish(t)).toBe(1); // semi-finalist
    expect(t.rounds[1]).toHaveLength(2);
    expect(t.rounds[2]).toHaveLength(1);
    expect(t.rounds[2][0].winner).not.toBe(YOU);
    expect(nextMatch(t)).toBeNull();
  });

  it('records a lost shootout as a defeat', () => {
    const t = newTournament(you, 3);
    recordYourMatch(t, [2, 2], [3, 4]);
    expect(status(t)).toBe('out');
    expect(t.rounds[0][0]).toMatchObject({ score: [2, 2], pens: [3, 4], winner: 1 });
  });

  it('only pairs winners in later rounds', () => {
    const t = newTournament(you, 11);
    expect(pairings(t, 1)).toBeNull(); // not until the quarter-finals are done
    recordYourMatch(t, [1, 0], null);
    const winners = t.rounds[0].map((r) => r.winner);
    expect(pairings(t, 1)!.flat()).toEqual(winners);
  });
});

describe('bot matches', () => {
  it('lets stronger teams win more often, but not always', () => {
    const t = newTournament(you, 5);
    const easy = t.entrants.findIndex((e) => e.level === 'easy');
    const hard = t.entrants.findIndex((e) => e.level === 'hard');
    const rnd = mulberry32(1);
    let hardWins = 0;
    for (let i = 0; i < 400; i++) if (simulate(t, easy, hard, rnd).winner === hard) hardWins++;
    expect(hardWins).toBeGreaterThan(260);
    expect(hardWins).toBeLessThan(400);
  });

  it('always has a winner, using penalties after a draw', () => {
    const t = newTournament(you, 5);
    const rnd = mulberry32(2);
    for (let i = 0; i < 200; i++) {
      const r = simulate(t, 2, 3, rnd);
      if (r.score[0] === r.score[1]) {
        expect(r.pens).not.toBeNull();
        expect(r.pens![0]).not.toBe(r.pens![1]);
      } else {
        expect(r.pens).toBeNull();
      }
      expect([2, 3]).toContain(r.winner);
    }
  });
});

describe('saving', () => {
  it('survives a round trip through JSON', () => {
    const t = newTournament(you, 9);
    recordYourMatch(t, [2, 1], null);
    expect(cleanTournament(JSON.parse(JSON.stringify(t)))).toEqual(t);
  });

  it('drops anything damaged instead of crashing', () => {
    const t: Tournament = newTournament(you, 9);
    recordYourMatch(t, [2, 1], null);
    const bad = (f: (x: any) => void) => {
      const copy = JSON.parse(JSON.stringify(t));
      f(copy);
      return cleanTournament(copy);
    };
    expect(cleanTournament(null)).toBeNull();
    expect(cleanTournament('nope')).toBeNull();
    expect(bad((x) => x.entrants.pop())).toBeNull();
    expect(bad((x) => (x.entrants[0].level = 'hard'))).toBeNull();
    expect(bad((x) => (x.rounds[0][0].winner = 5))).toBeNull();
    expect(bad((x) => (x.rounds[0][0].a = 3))).toBeNull();
    expect(bad((x) => (x.rounds[0][0].score = ['a', 1]))).toBeNull();
  });
});

describe('stats', () => {
  it('counts tournaments played and won, and the best finish', () => {
    const s = emptyStats();
    recordTournament(s, 1);
    recordTournament(s, 3);
    recordTournament(s, 0);
    expect(s.tournaments).toEqual({ played: 3, won: 1, best: 3 });
    expect(cleanStats(JSON.parse(JSON.stringify(s))).tournaments).toEqual(s.tournaments);
    expect(cleanStats({ tournaments: { played: 1, won: 5, best: 9 } }).tournaments).toEqual({ played: 1, won: 1, best: -1 });
  });
});

describe('drawn matches', () => {
  it('end at full time instead of going to golden goal when the tournament asks', () => {
    const w = createWorld({ duration: 1, drawAllowed: true });
    for (let i = 0; i < Math.ceil(5 / DT) && w.phase !== 'fulltime'; i++) step(w, []);
    expect(w.phase).toBe('fulltime');
    expect(w.winner).toBe(-1);
    expect(w.goldenGoal).toBe(false);
  });

  it('still go to golden goal in a normal match', () => {
    const w = createWorld({ duration: 1 });
    for (let i = 0; i < Math.ceil(5 / DT); i++) step(w, []);
    expect(w.goldenGoal).toBe(true);
  });
});
