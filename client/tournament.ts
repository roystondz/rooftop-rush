// Tournament against bots: eight teams, knockout (quarter-finals, semi-finals, final). You play
// your matches; the others are decided by a quick dice roll weighted by how strong each team is.
// A drawn match goes to a penalty shootout. Progress is saved in this browser, so you can stop
// and carry on later. Nothing here touches the screen: main.ts draws it.
import type { Difficulty } from '../shared/bot';
import { KITS } from '../shared/kits';
import { mulberry32 } from '../shared/math';

export interface Entrant {
  name: string;
  kit: number;
  /** Bot strength; 'you' for the player. */
  level: Difficulty | 'you';
}

export interface Result {
  /** Entrant indexes; `a` is listed first in the bracket. */
  a: number;
  b: number;
  score: [number, number];
  /** Shootout score when the match was drawn, else null. */
  pens: [number, number] | null;
  winner: number;
}

export interface Tournament {
  seed: number;
  /** Index 0 is always you. Bracket order: quarter-finals are 0v1, 2v3, 4v5, 6v7. */
  entrants: Entrant[];
  /** Finished results, one list per round (4, then 2, then 1). */
  rounds: Result[][];
}

export const ROUND_NAMES = ['Quarter-final', 'Semi-final', 'Final'] as const;
const MATCHES_PER_ROUND = [4, 2, 1];
export const YOU = 0;

/** Seven bot teams. Each tournament draws them into the bracket in a different order. */
const BOT_TEAMS: readonly { name: string; level: Difficulty }[] = [
  { name: 'HARBOUR FC', level: 'easy' },
  { name: 'METRO STARS', level: 'easy' },
  { name: 'IRON WOLVES', level: 'normal' },
  { name: 'COASTAL CITY', level: 'normal' },
  { name: 'MIDNIGHT UTD', level: 'normal' },
  { name: 'STORM RIDERS', level: 'hard' },
  { name: 'GOLDEN HAWKS', level: 'hard' },
];

/**
 * Where each strength goes in the bracket: an easy team first, a likely normal one in the
 * semi-final, and the two hard teams on the other side, so the final is the hardest match.
 */
const SLOT_LEVELS: readonly Difficulty[] = ['easy', 'normal', 'easy', 'hard', 'normal', 'hard', 'normal'];

const STRENGTH: { [K in Entrant['level']]: number } = { easy: 1, normal: 2, hard: 3, you: 2 };

export function newTournament(you: { name: string; kit: number }, seed = Math.floor(Math.random() * 1e9)): Tournament {
  const rnd = mulberry32(seed);
  const shuffle = <T>(list: T[]): T[] => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };
  const pools = new Map<Difficulty, { name: string; level: Difficulty }[]>();
  for (const t of shuffle([...BOT_TEAMS])) pools.set(t.level, [...(pools.get(t.level) ?? []), t]);
  // Every kit once among the bots, in a random order (one may match yours: the match sorts that out).
  const kits = shuffle(KITS.map((_, i) => i));
  const bots = SLOT_LEVELS.map((level, i) => ({ ...pools.get(level)!.shift()!, kit: kits[i] }));
  return { seed, entrants: [{ name: you.name, kit: you.kit, level: 'you' }, ...bots], rounds: [[], [], []] };
}

/** Who plays whom in a round, as entrant pairs. Later rounds need the earlier ones finished. */
export function pairings(t: Tournament, round: number): [number, number][] | null {
  if (round === 0) return [[0, 1], [2, 3], [4, 5], [6, 7]];
  const prev = t.rounds[round - 1];
  if (prev.length < MATCHES_PER_ROUND[round - 1]) return null;
  const winners = pairings(t, round - 1)!.map(([a, b]) => prev.find((r) => r.a === a && r.b === b)!.winner);
  const out: [number, number][] = [];
  for (let i = 0; i < winners.length; i += 2) out.push([winners[i], winners[i + 1]]);
  return out;
}

export type Status = 'playing' | 'out' | 'champion';

export function status(t: Tournament): Status {
  for (const round of t.rounds) {
    const mine = round.find((r) => r.a === YOU || r.b === YOU);
    if (mine && mine.winner !== YOU) return 'out';
  }
  return t.rounds[2].length === 1 && t.rounds[2][0].winner === YOU ? 'champion' : 'playing';
}

/** Your next match, or null when the tournament is over for you. */
export function nextMatch(t: Tournament): { round: number; opponent: number } | null {
  if (status(t) !== 'playing') return null;
  const round = t.rounds.findIndex((r, i) => r.length < MATCHES_PER_ROUND[i]);
  const pair = pairings(t, round)?.find(([a, b]) => a === YOU || b === YOU);
  if (!pair) return null;
  return { round, opponent: pair[0] === YOU ? pair[1] : pair[0] };
}

/**
 * Records your result (your score first) and plays out the rest of that round. If you're
 * knocked out, the remaining rounds are played out too, so the bracket shows who won.
 */
export function recordYourMatch(t: Tournament, yours: [number, number], pens: [number, number] | null): void {
  const next = nextMatch(t);
  if (!next) return;
  const { round, opponent } = next;
  const rnd = mulberry32(t.seed + round * 7919 + t.rounds[round].length);
  const pair = pairings(t, round)!;
  const youFirst = pair.some(([a]) => a === YOU);
  const iWon = pens ? pens[0] > pens[1] : yours[0] > yours[1];
  const flip = <T>(p: [T, T]): [T, T] => (youFirst ? p : [p[1], p[0]]);
  for (const [a, b] of pair) {
    if (a === YOU || b === YOU) {
      t.rounds[round].push({ a, b, score: flip(yours), pens: pens && flip(pens), winner: iWon ? YOU : opponent });
    } else {
      t.rounds[round].push(simulate(t, a, b, rnd));
    }
  }
  if (!iWon) {
    for (let r = round + 1; r < 3; r++) for (const [a, b] of pairings(t, r)!) t.rounds[r].push(simulate(t, a, b, rnd));
  }
}

/** A bot-vs-bot result: goals are random but the stronger team scores more on average. */
export function simulate(t: Tournament, a: number, b: number, rnd: () => number): Result {
  const sa = STRENGTH[t.entrants[a].level];
  const sb = STRENGTH[t.entrants[b].level];
  const goals = (mine: number, theirs: number) => poisson(Math.max(0.4, 1.8 + 0.6 * (mine - theirs)), rnd);
  const score: [number, number] = [goals(sa, sb), goals(sb, sa)];
  let pens: [number, number] | null = null;
  if (score[0] === score[1]) {
    const aWins = rnd() < 0.5 + 0.1 * (sa - sb);
    const loser = 2 + Math.floor(rnd() * 3);
    pens = aWins ? [loser + 1, loser] : [loser, loser + 1];
  }
  const aWon = pens ? pens[0] > pens[1] : score[0] > score[1];
  return { a, b, score, pens, winner: aWon ? a : b };
}

function poisson(mean: number, rnd: () => number): number {
  const limit = Math.exp(-mean);
  let k = 0;
  for (let p = rnd(); p > limit && k < 9; p *= rnd()) k++;
  return k;
}

/** How far you got: 0 out in the quarter-final, 1 semi-final, 2 lost the final, 3 champion. */
export function finish(t: Tournament): number {
  if (status(t) === 'champion') return 3;
  const lost = t.rounds.findIndex((round) => round.some((r) => (r.a === YOU || r.b === YOU) && r.winner !== YOU));
  return lost < 0 ? -1 : lost;
}

export const FINISH_NAMES = ['Quarter-finalist', 'Semi-finalist', 'Runner-up', 'Champion'] as const;

// --- saving ---------------------------------------------------------------------------

const KEY = 'rooftop-rush.tournament';

export function loadTournament(): Tournament | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? cleanTournament(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveTournament(t: Tournament | null): void {
  try {
    if (t) localStorage.setItem(KEY, JSON.stringify(t));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the tournament lasts until the page is closed.
  }
}

/** Accepts a saved tournament only if it is complete and consistent; anything else is dropped. */
export function cleanTournament(raw: unknown): Tournament | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { seed?: unknown; entrants?: unknown; rounds?: unknown };
  if (typeof r.seed !== 'number' || !Array.isArray(r.entrants) || !Array.isArray(r.rounds)) return null;
  if (r.entrants.length !== 8 || r.rounds.length !== 3) return null;
  const levels = ['easy', 'normal', 'hard', 'you'];
  const entrants: Entrant[] = [];
  for (const e of r.entrants as { name?: unknown; kit?: unknown; level?: unknown }[]) {
    if (!e || typeof e.name !== 'string' || !levels.includes(e.level as string)) return null;
    const kit = typeof e.kit === 'number' && e.kit >= 0 && e.kit < KITS.length ? Math.floor(e.kit) : 0;
    entrants.push({ name: e.name.slice(0, 20), kit, level: e.level as Entrant['level'] });
  }
  if (entrants[0].level !== 'you') return null;
  const t: Tournament = { seed: r.seed, entrants, rounds: [[], [], []] };
  const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 100 ? v : null);
  for (let round = 0; round < 3; round++) {
    const list = (r.rounds as unknown[])[round];
    if (!Array.isArray(list) || list.length > MATCHES_PER_ROUND[round]) return null;
    const pair = list.length ? pairings(t, round) : [];
    if (!pair) return null;
    for (const x of list as { a?: unknown; b?: unknown; score?: unknown; pens?: unknown; winner?: unknown }[]) {
      const ok = pair.some(([a, b]) => a === x?.a && b === x?.b);
      const score = Array.isArray(x?.score) ? x.score.map(n) : [];
      const pens = Array.isArray(x?.pens) ? x.pens.map(n) : null;
      if (!ok || score.length !== 2 || score.includes(null) || (pens && (pens.length !== 2 || pens.includes(null)))) return null;
      if (x.winner !== x.a && x.winner !== x.b) return null;
      t.rounds[round].push({ a: x.a as number, b: x.b as number, score: score as [number, number], pens: pens as [number, number] | null, winner: x.winner as number });
    }
  }
  return t;
}
