// Messages between browser and server. The server never trusts what a client sends:
// every incoming message goes through parseClientMessage, which rejects anything malformed.
import { BALL } from './constants';
import { clamp, lerp, wrapAngle } from './math';
import type { GameMode, Input, MatchEvent, Phase, Shootout, Team, World } from './types';

export const DEFAULT_PORT = 2567;
/** People per online room, and per team. Empty spots are played by bots. */
export const MAX_PLAYERS = 6;
export const MAX_PER_TEAM = 3;
/** The server sends a snapshot every this many ticks (1 = 60 per second). */
export const SNAPSHOT_EVERY = 1;

// --- inputs -------------------------------------------------------------------

/** An Input squeezed into three numbers: [moveX, moveZ, button bits]. */
export type PackedInput = [number, number, number];

const SPRINT = 1;
const SHOOT = 2;
const PASS = 4;
const TACKLE = 8;
const THROUGH = 16;

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

export function packInput(i: Input): PackedInput {
  const buttons =
    (i.sprint ? SPRINT : 0) |
    (i.shoot ? SHOOT : 0) |
    (i.pass ? PASS : 0) |
    (i.tackle ? TACKLE : 0) |
    (i.through ? THROUGH : 0);
  return [round(i.moveX, 2), round(i.moveZ, 2), buttons];
}

export function unpackInput(p: PackedInput): Input {
  const [x, z, b] = p;
  return {
    moveX: clamp(x, -1, 1),
    moveZ: clamp(z, -1, 1),
    sprint: (b & SPRINT) !== 0,
    shoot: (b & SHOOT) !== 0,
    pass: (b & PASS) !== 0,
    tackle: (b & TACKLE) !== 0,
    through: (b & THROUGH) !== 0,
  };
}

// --- snapshots ----------------------------------------------------------------

/** Everything a browser needs to draw one moment of the match. */
export interface Snapshot {
  tick: number;
  mode: GameMode;
  shootout: Shootout | null;
  time: number;
  phase: Phase;
  score: [number, number];
  rush: [number, number];
  golden: boolean;
  winner: Team | -1;
  kickoffTeam: Team;
  kickoffPending: boolean;
  controlled: number[]; // player id each seat (person) controls, or -1 for an empty seat
  p: number[]; // PLAYER_FIELDS numbers per player
  b: number[]; // ball: x, y, z, vx, vy, vz, owner, power
  ev: MatchEvent[]; // events since the previous snapshot
}

const PLAYER_FIELDS = 8; // x, z, vx, vz, facing, stamina, charge, flags
const STUNNED = 1;
const CHARGING = 2;
const SPRINTING = 4;
const DIVING = 8;

export function makeSnapshot(w: World, controlled: readonly number[], events: MatchEvent[]): Snapshot {
  const p: number[] = [];
  for (const q of w.players) {
    const flags =
      (q.stun > 0 ? STUNNED : 0) | (q.charging ? CHARGING : 0) | (q.sprinting ? SPRINTING : 0) | (q.dive > 0 ? DIVING : 0);
    p.push(round(q.x, 3), round(q.z, 3), round(q.vx, 2), round(q.vz, 2), round(q.facing, 3), round(q.stamina, 2), round(q.charge, 2), flags);
  }
  const b = w.ball;
  const so = w.shootout;
  return {
    tick: w.tick,
    mode: w.mode,
    shootout: so ? { taker: so.taker, kicks: [[...so.kicks[0]], [...so.kicks[1]]], kicked: so.kicked, kickTimer: round(so.kickTimer, 2) } : null,
    time: round(w.time, 2),
    phase: w.phase,
    score: [w.score[0], w.score[1]],
    rush: [round(w.rush[0], 1), round(w.rush[1], 1)],
    golden: w.goldenGoal,
    winner: w.winner,
    kickoffTeam: w.kickoffTeam,
    kickoffPending: w.kickoffPending,
    controlled: [...controlled],
    p,
    b: [round(b.x, 3), round(b.y, 3), round(b.z, 3), round(b.vx, 2), round(b.vy, 2), round(b.vz, 2), b.owner, b.power ? 1 : 0],
    ev: events,
  };
}

/** Writes a snapshot into an existing World (one made by createWorld) so the renderer can draw it. */
export function applySnapshot(w: World, s: Snapshot): void {
  w.tick = s.tick;
  w.mode = s.mode;
  w.shootout = s.shootout ? { ...s.shootout, kicks: [[...s.shootout.kicks[0]], [...s.shootout.kicks[1]]] } : null;
  w.time = s.time;
  w.phase = s.phase;
  w.score = [s.score[0], s.score[1]];
  w.rush = [s.rush[0], s.rush[1]];
  w.goldenGoal = s.golden;
  w.winner = s.winner;
  w.kickoffTeam = s.kickoffTeam;
  w.kickoffPending = s.kickoffPending;
  w.players.forEach((q, i) => {
    const o = i * PLAYER_FIELDS;
    q.x = s.p[o];
    q.z = s.p[o + 1];
    q.vx = s.p[o + 2];
    q.vz = s.p[o + 3];
    q.facing = s.p[o + 4];
    q.stamina = s.p[o + 5];
    q.charge = s.p[o + 6];
    const flags = s.p[o + 7];
    q.stun = flags & STUNNED ? 0.1 : 0;
    q.charging = (flags & CHARGING) !== 0;
    q.sprinting = (flags & SPRINTING) !== 0;
    q.dive = flags & DIVING ? 0.1 : 0;
  });
  const b = w.ball;
  [b.x, b.y, b.z, b.vx, b.vy, b.vz, b.owner] = s.b;
  b.power = s.b[7] === 1;
  b.y = Math.max(b.y, BALL.radius);
}

/** Like applySnapshot, but blends positions between two snapshots (t = 0..1) for smooth motion. */
export function lerpSnapshots(w: World, a: Snapshot, b: Snapshot, t: number): void {
  applySnapshot(w, b);
  w.players.forEach((q, i) => {
    const o = i * PLAYER_FIELDS;
    q.x = lerp(a.p[o], b.p[o], t);
    q.z = lerp(a.p[o + 1], b.p[o + 1], t);
    q.facing = a.p[o + 4] + wrapAngle(b.p[o + 4] - a.p[o + 4]) * t;
  });
  const ball = w.ball;
  // Don't blend across a teleport (kickoff reset): just show the newer position.
  if (Math.hypot(b.b[0] - a.b[0], b.b[2] - a.b[2]) < 5) {
    ball.x = lerp(a.b[0], b.b[0], t);
    ball.y = lerp(a.b[1], b.b[1], t);
    ball.z = lerp(a.b[2], b.b[2], t);
  }
}

// --- messages -----------------------------------------------------------------

export type ClientMessage =
  | { t: 'quick'; name?: string; mode?: GameMode }
  | { t: 'create'; name?: string; mode?: GameMode }
  | { t: 'join'; code: string; name?: string }
  | { t: 'team'; team: Team } // lobby: move to the other team
  | { t: 'start' } // lobby: the host starts the match
  | { t: 'input'; seq: number; i: PackedInput }
  | { t: 'switch' }
  | { t: 'leave' }
  | { t: 'ping'; at: number };

/** Someone in a room, as shown in the lobby. */
export interface LobbyPlayer {
  seat: number;
  name: string;
  team: Team;
}

/** Everything the lobby screen shows. Sent whenever anything about the room changes. */
export interface LobbyInfo {
  code: string;
  mode: GameMode;
  isPublic: boolean;
  /** Seat of the person who can start the match. */
  host: number;
  /** Your own seat. */
  you: number;
  started: boolean;
  /** Quick match: seconds until it starts by itself, or null. */
  startsIn: number | null;
  players: LobbyPlayer[];
  /** The two team names (each team is named by its first player). */
  names: [string, string];
}

export type ServerMessage =
  | ({ t: 'lobby' } & LobbyInfo)
  | { t: 'start'; you: number; team: Team; names: [string, string]; mode: GameMode }
  | { t: 'snap'; s: Snapshot; ack: number }
  | { t: 'notice'; text: string }
  | { t: 'error'; message: string }
  | { t: 'pong'; at: number };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Turns raw text from a client into a message, or null if it is not one we accept. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > 512) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== 'object' || m === null) return null;
  const msg = m as Record<string, unknown>;
  // A team name is optional; the server cleans it (shared/names.ts) before anyone sees it.
  const name = typeof msg.name === 'string' ? msg.name.slice(0, 64) : undefined;
  switch (msg.t) {
    case 'quick':
    case 'create': {
      const out: { t: 'quick' | 'create'; name?: string; mode?: GameMode } = { t: msg.t };
      if (name !== undefined) out.name = name;
      if (msg.mode === 'match' || msg.mode === 'penalties') out.mode = msg.mode;
      return out;
    }
    case 'switch':
    case 'start':
    case 'leave':
      return { t: msg.t };
    case 'team':
      return msg.team === 0 || msg.team === 1 ? { t: 'team', team: msg.team } : null;
    case 'join':
      if (typeof msg.code !== 'string' || !/^[A-Za-z]{4}$/.test(msg.code)) return null;
      return name === undefined ? { t: 'join', code: msg.code.toUpperCase() } : { t: 'join', code: msg.code.toUpperCase(), name };
    case 'ping':
      return isNum(msg.at) ? { t: 'ping', at: msg.at } : null;
    case 'input': {
      const i = msg.i;
      if (!isNum(msg.seq) || !Array.isArray(i) || i.length !== 3 || !i.every(isNum)) return null;
      const buttons = i[2] as number;
      if (!Number.isInteger(buttons) || buttons < 0 || buttons > 31) return null;
      return { t: 'input', seq: msg.seq, i: [i[0] as number, i[1] as number, buttons] };
    }
    default:
      return null;
  }
}
