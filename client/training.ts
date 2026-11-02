// Training drills on an empty pitch: ten balls each, scored, with your best kept in this browser.
//  - Curl: bend a shot round a defender into a ring low in either corner.
//  - Power: full-strength shots past a keeper; each shot's speed is shown.
//  - Through balls: a teammate runs past two defenders; play it into the zone ahead of them.
// This file sets up each attempt and judges it. training-game.ts runs it and draws it.
import { BALL, PITCH } from '../shared/constants';
import { mulberry32 } from '../shared/math';
import { createWorld } from '../shared/sim';
import type { MatchEvent, Player, World } from '../shared/types';

export type Drill = 'curl' | 'power' | 'through';
export const DRILLS: readonly Drill[] = ['curl', 'power', 'through'];
export const ATTEMPTS = 10;

export const DRILL_INFO: { [K in Drill]: { title: string; goal: string; how: string } } = {
  curl: { title: 'Curl', goal: 'Bend it round the defenders into a corner ring', how: 'Aim just outside a defender, hold shoot, and flick sideways as you let go to bend it in.' },
  power: { title: 'Power', goal: 'Beat the keeper with full-strength shots', how: 'Hold shoot all the way. Lower shots are harder to save.' },
  through: { title: 'Through balls', goal: 'Find the runner in the zone', how: 'Turn to aim and play a through ball (I / THROUGH) into the space ahead of your teammate.' },
};

const HALF_L = PITCH.length / 2;
const HALF_W = PITCH.width / 2;
const GOAL_HALF = PITCH.goalWidth / 2;

/** A ring to hit: in the goal mouth (upright) or on the grass (flat). */
export interface Target {
  x: number;
  y: number;
  z: number;
  radius: number;
  flat: boolean;
}

/** Everything about one attempt the drill needs to remember. */
export interface Attempt {
  drill: Drill;
  /** Where you stand; you can turn but not move until you've struck the ball. */
  spot: { x: number; z: number };
  you: number;
  /** Through balls: the teammate making the run, and where they run to. */
  runner: number;
  runTo: { x: number; z: number };
  /** Power: the keeper facing you. */
  keeper: number;
  targets: Target[];
  struck: boolean;
  /** Ticks since the ball was struck. */
  age: number;
  /** Ball x on the previous tick, to catch it crossing the goal line. */
  lastX: number;
  /** Power: how fast the shot left your foot (m/s). */
  speed: number;
}

export type Outcome = { done: false } | { done: true; success: boolean; message: string; detail?: string };

/** Curl drill: how far in front of you the defenders stand. */
const WALL_DISTANCE = 5;

// Players by role in createWorld: team 0 = 0 attacker, 1 midfielder, 2 keeper; team 1 = 3, 4, 5.
const YOU = 0;
const MATE = 1;

/** A fresh world for attempt `n` (0-based) of a drill, everyone in place. */
export function setupAttempt(drill: Drill, n: number, seed: number): { world: World; attempt: Attempt } {
  const w = createWorld({ duration: 9999 });
  Object.assign(w, { phase: 'playing', phaseTimer: 0, kickoffPending: false });
  const rnd = mulberry32(seed * 31 + n * 977);
  const park = (p: Player, corner: number) => {
    // Out of the way, in the corners of your own half.
    Object.assign(p, { x: -HALF_L + 1.5 + (corner >> 1) * 3, z: (corner & 1 ? 1 : -1) * (HALF_W - 1.5), vx: 0, vz: 0, facing: 0 });
  };
  w.players.forEach((p, i) => park(p, i));
  const attempt: Attempt = {
    drill,
    spot: { x: 0, z: 0 },
    you: YOU,
    runner: -1,
    runTo: { x: 0, z: 0 },
    keeper: -1,
    targets: [],
    struck: false,
    age: 0,
    lastX: 0,
    speed: 0,
  };
  const side = rnd() < 0.5 ? -1 : 1;

  if (drill === 'curl') {
    // A defender stands between you and the middle of the goal; rings sit low in both corners.
    // Go round him: curl lets you start the ball outside him and bend it into a corner. (Shots in
    // this game stay low, so the rings are too: you beat the man by bending it, not lifting it.)
    const spot = { x: HALF_L - 11 - rnd() * 3, z: side * (1 + rnd() * 3) };
    attempt.spot = spot;
    attempt.targets = [-1, 1].map((s) => ({ x: HALF_L, y: 0.6, z: s * (GOAL_HALF - 0.85), radius: 0.85, flat: false }));
    // One defender on the straight line to each ring, so a straight shot is blocked.
    attempt.targets.forEach((ring, i) => {
      const a = Math.atan2(ring.z - spot.z, HALF_L - spot.x);
      Object.assign(w.players[3 + i], { x: spot.x + Math.cos(a) * WALL_DISTANCE, z: spot.z + Math.sin(a) * WALL_DISTANCE, facing: Math.PI });
    });
    placeYou(w, spot, Math.atan2(-spot.z, HALF_L - spot.x));
  } else if (drill === 'power') {
    const spot = { x: HALF_L - 11 - rnd() * 6, z: side * rnd() * 5 };
    attempt.spot = spot;
    attempt.keeper = 5;
    Object.assign(w.players[5], { x: HALF_L - 0.8, z: 0, facing: Math.PI });
    placeYou(w, spot, Math.atan2(-spot.z, HALF_L - spot.x));
  } else {
    // Through balls: you in midfield, your teammate level with you out wide, two defenders between.
    const spot = { x: -4 - rnd() * 3, z: -side * (1 + rnd() * 2) };
    attempt.spot = spot;
    attempt.runner = MATE;
    const runnerZ = side * (4 + rnd() * 3);
    Object.assign(w.players[MATE], { x: spot.x + 2, z: runnerZ, facing: 0 });
    attempt.runTo = { x: HALF_L - 6, z: side * (1 + rnd() * 2) };
    Object.assign(w.players[3], { x: 5, z: runnerZ * 0.55, facing: Math.PI });
    Object.assign(w.players[4], { x: 6.5, z: -runnerZ * 0.2, facing: Math.PI });
    attempt.targets = [{ x: attempt.runTo.x, y: 0.03, z: attempt.runTo.z, radius: 3.5, flat: true }];
    placeYou(w, spot, Math.atan2(runnerZ - spot.z, 8));
  }
  attempt.lastX = w.ball.x;
  return { world: w, attempt };
}

function placeYou(w: World, spot: { x: number; z: number }, facing: number): void {
  const p = w.players[YOU];
  Object.assign(p, { x: spot.x, z: spot.z, vx: 0, vz: 0, facing });
  w.ball.owner = YOU;
  w.ball.x = spot.x + Math.cos(facing);
  w.ball.z = spot.z + Math.sin(facing);
  w.ball.y = BALL.radius;
}

/** Steering for the teammate on a through-ball run: wait until you're ready, then go. */
export function runnerInput(w: World, a: Attempt): { moveX: number; moveZ: number; sprint: boolean } {
  const p = w.players[a.runner];
  if (!p || w.ball.owner === p.id) return { moveX: 0, moveZ: 0, sprint: false };
  const dx = a.runTo.x - p.x;
  const dz = a.runTo.z - p.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.4) return { moveX: 0, moveZ: 0, sprint: false };
  // A loose ball meant for them close by: go and get it.
  const b = w.ball;
  if (a.struck && b.owner < 0 && Math.hypot(b.x - p.x, b.z - p.z) < 4) {
    const bx = b.x - p.x;
    const bz = b.z - p.z;
    const bd = Math.hypot(bx, bz) || 1;
    return { moveX: bx / bd, moveZ: bz / bd, sprint: true };
  }
  return { moveX: dx / d, moveZ: dz / d, sprint: true };
}

/** Keeps you on your spot (you may turn) until the ball is struck. Call after each step. */
export function holdSpot(w: World, a: Attempt): void {
  if (a.struck) return;
  const p = w.players[a.you];
  Object.assign(p, { x: a.spot.x, z: a.spot.z, vx: 0, vz: 0 });
}

/** Looks at one tick's events and the ball, and says whether the attempt is over and how it went. */
export function judge(w: World, a: Attempt, events: readonly MatchEvent[]): Outcome {
  const b = w.ball;
  const kicked = events.find((e) => (e.type === 'shot' || e.type === 'powerShot' || e.type === 'pass') && e.player === a.you);
  if (kicked && !a.struck) {
    a.struck = true;
    a.age = 0;
    if (a.drill === 'power') a.targets = []; // nothing to draw
  }
  const crossed = a.lastX < HALF_L && b.x >= HALF_L;
  a.lastX = b.x;
  if (!a.struck) return { done: false };
  a.age++;
  const speed = Math.hypot(b.vx, b.vy, b.vz);

  if (a.drill === 'curl') {
    if (crossed) {
      const hit = a.targets.some((t) => Math.hypot(b.z - t.z, b.y - t.y) < t.radius + BALL.radius * 0.5);
      if (hit) return { done: true, success: true, message: 'TARGET!' };
      const onTarget = Math.abs(b.z) < GOAL_HALF && b.y < PITCH.goalHeight;
      return { done: true, success: false, message: onTarget ? 'GOAL, but not in a ring' : 'MISSED' };
    }
    if (b.owner >= 0) return { done: true, success: false, message: 'BLOCKED' };
    if (a.age > 150 || (a.age > 20 && speed < 0.5)) return { done: true, success: false, message: 'MISSED' };
    return { done: false };
  }

  if (a.drill === 'power') {
    if (kicked) a.speed = speed;
    const kmh = Math.round(a.speed * 3.6);
    if (events.some((e) => e.type === 'goal')) return { done: true, success: true, message: 'GOAL!', detail: `${kmh} km/h` };
    if (events.some((e) => e.type === 'save')) return { done: true, success: false, message: 'SAVED', detail: `${kmh} km/h` };
    if (crossed || a.age > 150 || (a.age > 20 && speed < 0.5) || (b.owner >= 0 && b.owner !== a.you)) {
      return { done: true, success: false, message: 'MISSED', detail: `${kmh} km/h` };
    }
    return { done: false };
  }

  // Through balls: the runner must collect it inside the zone.
  const zone = a.targets[0];
  if (b.owner === a.runner) {
    const runner = w.players[a.runner];
    const inZone = Math.hypot(runner.x - zone.x, runner.z - zone.z) < zone.radius;
    return inZone
      ? { done: true, success: true, message: 'PERFECT BALL!' }
      : { done: true, success: false, message: 'TOO SHORT' };
  }
  if (b.owner >= 0 && b.owner !== a.you) return { done: true, success: false, message: 'INTERCEPTED' };
  if (crossed || a.age > 240 || (a.age > 30 && speed < 0.3)) return { done: true, success: false, message: 'TOO LONG' };
  return { done: false };
}

// --- best scores ------------------------------------------------------------------

const KEY = 'rooftop-rush.training';
export type Bests = { [K in Drill]: number } & { fastest: number };

export function loadBests(): Bests {
  const empty: Bests = { curl: 0, power: 0, through: 0, fastest: 0 };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { [k: string]: unknown };
    const n = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(max, Math.floor(v)) : 0);
    return { curl: n(raw.curl, ATTEMPTS), power: n(raw.power, ATTEMPTS), through: n(raw.through, ATTEMPTS), fastest: n(raw.fastest, 300) };
  } catch {
    return empty;
  }
}

export function saveBests(b: Bests): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(b));
  } catch {
    // Storage blocked: best scores just aren't remembered.
  }
}
