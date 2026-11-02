// Your record on this device: results against each bot level and online, your goals, penalties,
// win streaks and recent matches. Stored in localStorage like the settings, so every read and
// write is allowed to fail (private browsing, blocked storage) and the game still plays normally.
import { penaltyDuel } from '../shared/sim';
import type { GameMode, MatchEvent, Team, World } from '../shared/types';

/** Who you played against: a bot level, or other people online. */
export type Opponent = 'easy' | 'normal' | 'hard' | 'online';
export const OPPONENTS: readonly Opponent[] = ['easy', 'normal', 'hard', 'online'];

export interface Tally {
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
}

export interface RecentResult {
  at: number; // ms since 1970
  mode: GameMode;
  opponent: Opponent;
  result: 'W' | 'D' | 'L';
  /** Your team's name and score first. */
  us: string;
  them: string;
  score: [number, number];
}

export interface Stats {
  matches: { [K in Opponent]: Tally };
  shootouts: { [K in Opponent]: Tally };
  /** Goals scored by the player you were controlling (own goals don't count). */
  yourGoals: number;
  /** Shootout kicks you took and scored; kicks you faced in goal and kept out. */
  pens: { taken: number; scored: number; faced: number; saved: number };
  streak: number;
  bestStreak: number;
  biggestWin: { margin: number; line: string } | null;
  recent: RecentResult[];
}

const KEY = 'rooftop-rush.stats';
const RECENT = 10;

const emptyTally = (): Tally => ({ played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0 });
const byOpponent = () => ({ easy: emptyTally(), normal: emptyTally(), hard: emptyTally(), online: emptyTally() });

export function emptyStats(): Stats {
  return {
    matches: byOpponent(),
    shootouts: byOpponent(),
    yourGoals: 0,
    pens: { taken: 0, scored: 0, faced: 0, saved: 0 },
    streak: 0,
    bestStreak: 0,
    biggestWin: null,
    recent: [],
  };
}

/** Adds up every row: total played, won, drawn and lost across matches and shootouts. */
export function totals(s: Stats): Tally {
  const t = emptyTally();
  for (const table of [s.matches, s.shootouts]) {
    for (const o of OPPONENTS) {
      for (const k of Object.keys(t) as (keyof Tally)[]) t[k] += table[o][k];
    }
  }
  return t;
}

/** Counts your goals and penalties as they happen. `controlled` is the player you control. */
export function recordEvent(s: Stats, w: World, e: MatchEvent, myTeam: Team, controlled: number): void {
  if (w.mode === 'penalties') {
    if (e.type !== 'goal' && e.type !== 'penaltyMiss') return;
    const duel = penaltyDuel(w);
    const scored = e.type === 'goal';
    if (e.team === myTeam && e.player === controlled) {
      s.pens.taken++;
      if (scored) s.pens.scored++;
    } else if (e.team !== myTeam && duel && duel.keeper.id === controlled) {
      s.pens.faced++;
      if (!scored) s.pens.saved++;
    }
    return;
  }
  if (e.type === 'goal' && !e.ownGoal && e.team === myTeam && e.player === controlled) s.yourGoals++;
}

/** Adds a finished match or shootout. `names` are [team 0, team 1]. */
export function recordResult(
  s: Stats,
  w: World,
  myTeam: Team,
  opponent: Opponent,
  names: readonly [string, string],
  at = Date.now(),
): RecentResult {
  const them: Team = myTeam === 0 ? 1 : 0;
  const ours = w.score[myTeam];
  const theirs = w.score[them];
  const result = w.winner === -1 ? 'D' : w.winner === myTeam ? 'W' : 'L';
  const row = (w.mode === 'penalties' ? s.shootouts : s.matches)[opponent];
  row.played++;
  row.goalsFor += ours;
  row.goalsAgainst += theirs;
  if (result === 'W') row.won++;
  else if (result === 'D') row.drawn++;
  else row.lost++;

  s.streak = result === 'W' ? s.streak + 1 : 0;
  s.bestStreak = Math.max(s.bestStreak, s.streak);
  const margin = ours - theirs;
  if (result === 'W' && w.mode === 'match' && margin > (s.biggestWin?.margin ?? 0)) {
    s.biggestWin = { margin, line: `${names[myTeam]} ${ours}–${theirs} ${names[them]}` };
  }
  const entry: RecentResult = { at, mode: w.mode, opponent, result, us: names[myTeam], them: names[them], score: [ours, theirs] };
  s.recent = [entry, ...s.recent].slice(0, RECENT);
  return entry;
}

export function loadStats(): Stats {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? cleanStats(JSON.parse(raw)) : emptyStats();
  } catch {
    return emptyStats();
  }
}

export function saveStats(s: Stats): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable: this match just won't be remembered.
  }
}

export function clearStats(): Stats {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing stored, or storage blocked: either way we start again from zero.
  }
  return emptyStats();
}

/** Rebuilds stats from whatever was stored, keeping only values of the right shape. */
export function cleanStats(raw: unknown): Stats {
  const s = emptyStats();
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as { [k: string]: unknown };
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  const table = (from: unknown, into: Stats['matches']) => {
    if (!from || typeof from !== 'object') return;
    for (const o of OPPONENTS) {
      const row = (from as { [k: string]: unknown })[o] as { [k: string]: unknown } | undefined;
      if (!row || typeof row !== 'object') continue;
      for (const k of Object.keys(into[o]) as (keyof Tally)[]) into[o][k] = count(row[k]);
    }
  };
  table(r.matches, s.matches);
  table(r.shootouts, s.shootouts);
  s.yourGoals = count(r.yourGoals);
  const pens = (r.pens ?? {}) as { [k: string]: unknown };
  s.pens = { taken: count(pens.taken), scored: count(pens.scored), faced: count(pens.faced), saved: count(pens.saved) };
  s.streak = count(r.streak);
  s.bestStreak = Math.max(count(r.bestStreak), s.streak);
  const big = r.biggestWin as { margin?: unknown; line?: unknown } | null;
  if (big && typeof big.line === 'string' && count(big.margin) > 0) {
    s.biggestWin = { margin: count(big.margin), line: big.line.slice(0, 60) };
  }
  if (Array.isArray(r.recent)) {
    for (const e of r.recent.slice(0, RECENT)) {
      if (!e || typeof e !== 'object') continue;
      const x = e as { [k: string]: unknown };
      const score = Array.isArray(x.score) ? x.score : [];
      if (
        !['W', 'D', 'L'].includes(x.result as string) ||
        !OPPONENTS.includes(x.opponent as Opponent) ||
        (x.mode !== 'match' && x.mode !== 'penalties')
      ) {
        continue;
      }
      s.recent.push({
        at: count(x.at),
        mode: x.mode,
        opponent: x.opponent as Opponent,
        result: x.result as RecentResult['result'],
        us: String(x.us ?? '').slice(0, 20),
        them: String(x.them ?? '').slice(0, 20),
        score: [count(score[0]), count(score[1])],
      });
    }
  }
  return s;
}
