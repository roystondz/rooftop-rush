// The whole match simulation. It never reads the clock, the keyboard or Math.random,
// so the same inputs always give the same result. That is what lets a server run it later.
import { BALL, DT, MATCH, PASS, PITCH, PLAYER, RUSH, SHOOTOUT, SHOT } from './constants';
import { clamp, distToSegment, lerp, turnTowards } from './math';
import { NO_INPUT } from './types';
import type { Ball, GameMode, Input, KickKind, MatchEvent, Player, Role, Team, World } from './types';

const HALF_L = PITCH.length / 2;
const HALF_W = PITCH.width / 2;
const GOAL_HALF = PITCH.goalWidth / 2;
const ROLES: readonly Role[] = ['attacker', 'midfielder', 'keeper'];

export const attackDir = (team: Team): 1 | -1 => (team === 0 ? 1 : -1);
export const ownGoalX = (team: Team): number => -attackDir(team) * HALF_L;

export function inOwnBox(p: Player): boolean {
  return Math.abs(p.x - ownGoalX(p.team)) < PITCH.boxDepth && Math.abs(p.z) < PITCH.boxHalfWidth;
}

export function createWorld(options: { duration?: number; mode?: GameMode; drawAllowed?: boolean } = {}): World {
  const players: Player[] = [];
  for (const team of [0, 1] as const) {
    for (const role of ROLES) players.push(makePlayer(players.length, team, role));
  }
  const mode = options.mode ?? 'match';
  const w: World = {
    tick: 0,
    mode,
    shootout: mode === 'penalties' ? { taker: 0, kicks: [[], []], kicked: false, kickTimer: 0 } : null,
    time: options.duration ?? MATCH.duration,
    phase: 'kickoff',
    phaseTimer: MATCH.kickoffDelay,
    score: [0, 0],
    goldenGoal: false,
    drawAllowed: options.drawAllowed ?? false,
    kickoffTeam: 0,
    kickoffPending: mode === 'match', // shootouts have no kickoff pass
    players,
    ball: makeBall(),
    rush: [0, 0],
    events: [],
    lastScorer: -1,
    winner: -1,
  };
  if (mode === 'penalties') setupPenalty(w);
  else resetForKickoff(w, 0);
  return w;
}

/** Advances the match by one fixed tick. `inputs` is indexed by player id. */
export function step(w: World, inputs: ReadonlyArray<Input | undefined>): void {
  w.events.length = 0;
  w.tick++;
  if (w.mode === 'penalties') {
    stepShootout(w, inputs);
    return;
  }

  switch (w.phase) {
    case 'fulltime':
      return;
    case 'kickoff':
      w.phaseTimer -= DT;
      if (w.phaseTimer <= 0) {
        w.phase = 'playing';
        w.phaseTimer = MATCH.kickoffPassTime;
        emit(w, { type: 'whistle' });
        // The kicker starts with the ball and must pass it to a teammate.
        const kicker = w.players.find((p) => p.team === w.kickoffTeam && p.role === 'attacker');
        if (kicker) takeBall(w, kicker);
        else w.kickoffPending = false;
      }
      return;
    case 'goal':
      w.phaseTimer -= DT;
      celebrate(w);
      updateBall(w);
      if (w.phaseTimer <= 0) {
        if (w.goldenGoal || w.time <= 0) endMatch(w);
        else resetForKickoff(w, w.kickoffTeam);
      }
      return;
    case 'playing':
      break;
  }

  w.time = Math.max(0, w.time - DT);
  if (w.time === 0 && !w.goldenGoal) {
    if (w.score[0] === w.score[1] && !w.drawAllowed) {
      w.goldenGoal = true;
      emit(w, { type: 'goldenGoal' });
    } else {
      endMatch(w);
      return;
    }
  }

  if (w.kickoffPending) {
    w.phaseTimer -= DT;
    const kicker = w.ball.owner >= 0 ? w.players[w.ball.owner] : undefined;
    if (!kicker || kicker.team !== w.kickoffTeam) w.kickoffPending = false;
    else if (w.phaseTimer <= 0) pass(w, kicker); // took too long: pass for them
  }

  for (const p of w.players) updatePlayer(w, p, inputs[p.id] ?? NO_INPUT);
  separatePlayers(w);
  if (w.kickoffPending) {
    for (const p of w.players) if (p.team !== w.kickoffTeam) keepOutOfCentreCircle(p);
  }
  updateBall(w);
  if (w.phase === 'playing') checkBallContacts(w);
}

export function resetForKickoff(w: World, kickingOff: Team): void {
  for (const p of w.players) {
    const [x, z] = kickoffSpot(p, p.team === kickingOff);
    Object.assign(p, {
      x,
      z,
      vx: 0,
      vz: 0,
      facing: p.team === 0 ? 0 : Math.PI,
      stamina: 1,
      sprinting: false,
      charging: false,
      charge: 0,
      kickCooldown: 0,
      tackleCooldown: 0,
      stun: 0,
    });
  }
  Object.assign(w.ball, makeBall());
  w.phase = 'kickoff';
  w.phaseTimer = MATCH.kickoffDelay;
  w.kickoffTeam = kickingOff;
  w.kickoffPending = true;
  emit(w, { type: 'kickoff', team: kickingOff });
}

/** Before the kickoff pass, the defending team must stay outside the centre circle. */
export function keepOutOfCentreCircle(p: Player): void {
  const min = PITCH.centreCircle + PLAYER.radius;
  const d = Math.hypot(p.x, p.z);
  if (d >= min) return;
  // Exactly on the centre spot: step back toward their own goal.
  const nx = d < 1e-6 ? -attackDir(p.team) : p.x / d;
  const nz = d < 1e-6 ? 0 : p.z / d;
  p.x = nx * min;
  p.z = nz * min;
  const vn = p.vx * nx + p.vz * nz;
  if (vn < 0) {
    p.vx -= vn * nx;
    p.vz -= vn * nz;
  }
}

export interface PassChoice {
  player: Player;
  score: number;
}

/**
 * Rates every teammate as a pass target: open passing lanes, forward passes and
 * (for humans) passes in the direction you are facing score higher.
 */
export function bestPassTarget(w: World, from: Player, facingWeight: number): PassChoice | undefined {
  const fx = Math.cos(from.facing);
  const fz = Math.sin(from.facing);
  let best: PassChoice | undefined;
  for (const mate of w.players) {
    if (mate.team !== from.team || mate.id === from.id) continue;
    const dx = mate.x - from.x;
    const dz = mate.z - from.z;
    const dist = Math.hypot(dx, dz);
    if (dist < PASS.minDistance) continue;
    const facingScore = (dx * fx + dz * fz) / dist;
    let openness = 4;
    for (const opp of w.players) {
      if (opp.team === from.team) continue;
      openness = Math.min(openness, distToSegment(opp.x, opp.z, from.x, from.z, mate.x, mate.z));
    }
    const forward = (dx * attackDir(from.team)) / HALF_L;
    let score = facingScore * facingWeight + openness * 0.5 + forward - dist * 0.03;
    if (facingWeight > 0.5 && facingScore < -0.2) score -= 3;
    if (!best || score > best.score) best = { player: mate, score };
  }
  return best;
}

// ---------------------------------------------------------------------------

function makePlayer(id: number, team: Team, role: Role): Player {
  return {
    id,
    team,
    role,
    x: 0,
    z: 0,
    vx: 0,
    vz: 0,
    facing: 0,
    stamina: 1,
    sprinting: false,
    speedScale: 1,
    charging: false,
    charge: 0,
    kickCooldown: 0,
    tackleCooldown: 0,
    stun: 0,
    dive: 0,
    prevShoot: false,
    prevPass: false,
    prevThrough: false,
    prevTackle: false,
  };
}

function makeBall(): Ball {
  return {
    x: 0,
    y: BALL.radius,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    spin: 0,
    owner: -1,
    lastTouch: -1,
    lastKick: { by: -1, kind: 'none', target: -1 },
    power: false,
  };
}

/** Positions written for team 0 (defending -x); team 1 is the mirror image. */
function kickoffSpot(p: Player, kickingOff: boolean): [number, number] {
  let x: number;
  let z: number;
  switch (p.role) {
    case 'attacker':
      x = kickingOff ? -0.85 : -6.5;
      z = 0;
      break;
    case 'midfielder':
      x = -8;
      z = -4.5;
      break;
    case 'keeper':
      x = -HALF_L + 1.4;
      z = 0;
      break;
  }
  return p.team === 0 ? [x, z] : [-x, -z];
}

function emit(w: World, e: MatchEvent): void {
  w.events.push(e);
}

function addRush(w: World, team: Team, amount: number): void {
  const before = w.rush[team];
  w.rush[team] = Math.min(RUSH.max, before + amount);
  if (before < RUSH.max && w.rush[team] >= RUSH.max) emit(w, { type: 'rushReady', team });
}

function endMatch(w: World): void {
  w.phase = 'fulltime';
  w.winner = w.score[0] === w.score[1] ? -1 : w.score[0] > w.score[1] ? 0 : 1;
  emit(w, { type: 'whistle' });
  emit(w, { type: 'fulltime', team: w.winner === -1 ? undefined : w.winner });
}

// --- players ----------------------------------------------------------------

function updatePlayer(w: World, p: Player, inp: Input): void {
  p.kickCooldown = Math.max(0, p.kickCooldown - DT);
  p.tackleCooldown = Math.max(0, p.tackleCooldown - DT);

  if (p.stun > 0) {
    p.stun = Math.max(0, p.stun - DT);
    p.vx *= 0.9;
    p.vz *= 0.9;
    p.sprinting = false;
    p.charging = false;
    p.charge = 0;
    movePlayer(p);
    rememberButtons(p, inp);
    return;
  }

  const hasBall = w.ball.owner === p.id;

  if (hasBall && w.kickoffPending) {
    // Taking the kickoff: stand still, turn to aim, and pass. No dribbling or shooting.
    holdForKickoff(p, inp);
    if (inp.pass && !p.prevPass) pass(w, p);
    else if (inp.through && !p.prevThrough) pass(w, p, true);
    rememberButtons(p, inp);
    return;
  }

  const { mx, mz } = moveWithInput(p, inp, hasBall);

  // Shoot: hold to charge, release to kick. Works on a loose ball too (first-time shot).
  if (inp.shoot) {
    p.charging = true;
    p.charge = Math.min(PLAYER.maxCharge, p.charge + DT);
  } else if (p.charging) {
    if (hasBall || canHitFirstTime(w, p)) {
      // Sideways input relative to facing becomes curl.
      const lateral = -mx * Math.sin(p.facing) + mz * Math.cos(p.facing);
      shoot(w, p, lateral);
    }
    p.charging = false;
    p.charge = 0;
  }

  const passPressed = inp.pass && !p.prevPass;
  const throughPressed = !!inp.through && !p.prevThrough;
  if ((passPressed || throughPressed) && !p.charging && (w.ball.owner === p.id || canHitFirstTime(w, p))) {
    pass(w, p, throughPressed && !passPressed);
  }

  if (inp.tackle && !p.prevTackle && w.ball.owner !== p.id && p.tackleCooldown <= 0) {
    tackle(w, p);
  }

  rememberButtons(p, inp);
}

/**
 * Running, sprinting and turning for one tick. Exported because the browser runs this same
 * code to predict your own player online. Returns the move direction it used.
 */
export function moveWithInput(p: Player, inp: Input, hasBall: boolean): { mx: number; mz: number } {
  let mx = clamp(inp.moveX, -1, 1);
  let mz = clamp(inp.moveZ, -1, 1);
  const mag = Math.hypot(mx, mz);
  if (mag > 1) {
    mx /= mag;
    mz /= mag;
  }
  const moving = mag > 0.15;

  p.sprinting = inp.sprint && moving && p.stamina > 0.05;
  p.stamina = p.sprinting
    ? Math.max(0, p.stamina - PLAYER.staminaDrain * DT)
    : Math.min(1, p.stamina + PLAYER.staminaRegen * DT);

  let maxSpeed = (p.sprinting ? PLAYER.sprintSpeed : PLAYER.speed) * p.speedScale;
  if (hasBall) maxSpeed *= PLAYER.dribbleSpeedFactor;
  if (p.charging) maxSpeed *= PLAYER.chargeSpeedFactor;

  // Accelerate toward the wanted velocity, limited by PLAYER.accel.
  let dvx = mx * maxSpeed - p.vx;
  let dvz = mz * maxSpeed - p.vz;
  const dv = Math.hypot(dvx, dvz);
  const maxDv = PLAYER.accel * DT;
  if (dv > maxDv) {
    dvx *= maxDv / dv;
    dvz *= maxDv / dv;
  }
  p.vx += dvx;
  p.vz += dvz;
  movePlayer(p);

  if (moving) {
    const rate = p.charging ? PLAYER.chargeTurnRate : PLAYER.turnRate;
    p.facing = turnTowards(p.facing, Math.atan2(mz, mx), rate * DT);
  }
  return { mx, mz };
}

/** The kicker before the kickoff pass: can only turn on the spot to choose who to pass to. */
export function holdForKickoff(p: Player, inp: Input): void {
  p.vx = 0;
  p.vz = 0;
  p.sprinting = false;
  p.charging = false;
  p.charge = 0;
  p.stamina = Math.min(1, p.stamina + PLAYER.staminaRegen * DT);
  if (Math.hypot(inp.moveX, inp.moveZ) > 0.15) {
    p.facing = turnTowards(p.facing, Math.atan2(inp.moveZ, inp.moveX), PLAYER.turnRate * DT);
  }
}

/** Where the ball sits while `p` dribbles it: just in front of their feet. */
export function carriedBallPosition(p: Player): { x: number; z: number } {
  const off = PLAYER.radius + BALL.radius + 0.12;
  return { x: p.x + Math.cos(p.facing) * off, z: p.z + Math.sin(p.facing) * off };
}

function rememberButtons(p: Player, inp: Input): void {
  p.prevShoot = inp.shoot;
  p.prevPass = inp.pass;
  p.prevThrough = !!inp.through;
  p.prevTackle = inp.tackle;
}

function movePlayer(p: Player): void {
  p.x += p.vx * DT;
  p.z += p.vz * DT;
  const maxX = HALF_L - PLAYER.radius;
  const maxZ = HALF_W - PLAYER.radius;
  if (Math.abs(p.x) > maxX) {
    p.x = Math.sign(p.x) * maxX;
    p.vx = 0;
  }
  if (Math.abs(p.z) > maxZ) {
    p.z = Math.sign(p.z) * maxZ;
    p.vz = 0;
  }
}

function separatePlayers(w: World): void {
  const min = PLAYER.radius * 2;
  const ps = w.players;
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i];
      const b = ps[j];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d >= min) continue;
      const push = (min - d) / 2;
      // Two players on the exact same spot: separate them along x.
      const nx = d < 1e-6 ? 1 : dx / d;
      const nz = d < 1e-6 ? 0 : dz / d;
      a.x -= nx * push;
      a.z -= nz * push;
      b.x += nx * push;
      b.z += nz * push;
      movePlayerBounds(a);
      movePlayerBounds(b);
    }
  }
}

function movePlayerBounds(p: Player): void {
  p.x = clamp(p.x, -HALF_L + PLAYER.radius, HALF_L - PLAYER.radius);
  p.z = clamp(p.z, -HALF_W + PLAYER.radius, HALF_W - PLAYER.radius);
}

function canHitFirstTime(w: World, p: Player): boolean {
  const b = w.ball;
  return (
    b.owner === -1 &&
    p.kickCooldown <= 0 &&
    b.y < 1.5 &&
    Math.hypot(b.x - p.x, b.z - p.z) < PLAYER.firstTimeReach
  );
}

// --- actions ----------------------------------------------------------------

function kickBall(w: World, p: Player, kind: KickKind, vx: number, vy: number, vz: number, spin: number, target = -1): void {
  const b = w.ball;
  b.owner = -1;
  b.vx = vx;
  b.vy = vy;
  b.vz = vz;
  b.spin = spin;
  b.y = Math.max(b.y, BALL.radius);
  b.lastTouch = p.id;
  b.lastKick = { by: p.id, kind, target };
  b.power = false;
  p.kickCooldown = PLAYER.kickCooldown;
}

function shoot(w: World, p: Player, lateral: number): void {
  const c = clamp(p.charge / PLAYER.maxCharge, 0, 1);
  const power = w.rush[p.team] >= RUSH.max;
  const speed = lerp(SHOT.minSpeed, SHOT.maxSpeed, c) * (power ? SHOT.powerMultiplier : 1);
  const lift = power ? SHOT.powerLift : lerp(SHOT.minLift, SHOT.maxLift, c * c);
  const spin = clamp(lateral, -1, 1) * SHOT.maxCurl * (power ? 0.3 : 0.35 + 0.65 * c);
  kickBall(w, p, 'shot', Math.cos(p.facing) * speed, lift, Math.sin(p.facing) * speed, spin);
  if (power) {
    w.ball.power = true;
    w.rush[p.team] = 0;
  }
  emit(w, { type: power ? 'powerShot' : 'shot', player: p.id, team: p.team, strength: c });
}

/** `through`: play it into the space ahead of the teammate, for them to run onto. */
function pass(w: World, p: Player, through = false): void {
  w.kickoffPending = false;
  const choice = bestPassTarget(w, p, 1.5);
  if (!choice) {
    // Nobody to pass to: knock it forward.
    kickBall(w, p, 'pass', Math.cos(p.facing) * 13, PASS.lift, Math.sin(p.facing) * 13, 0);
    emit(w, { type: 'pass', player: p.id, team: p.team, target: -1 });
    return;
  }
  const mate = choice.player;
  const lead = through ? PASS.throughLead : PASS.lead;
  const tx = clamp(
    mate.x + mate.vx * lead + (through ? attackDir(p.team) * PASS.throughSpace : 0),
    -HALF_L + 1,
    HALF_L - 1,
  );
  const tz = clamp(mate.z + mate.vz * lead, -HALF_W + 1, HALF_W - 1);
  const dx = tx - p.x;
  const dz = tz - p.z;
  const dist = Math.max(0.01, Math.hypot(dx, dz));
  const lofted = dist > PASS.loftDistance;
  const speed =
    clamp(PASS.minSpeed + dist * PASS.speedPerMeter, PASS.minSpeed, PASS.maxSpeed) *
    (lofted ? 0.8 : 1) *
    (through ? PASS.throughSpeedFactor : 1);
  p.facing = Math.atan2(dz, dx);
  kickBall(w, p, 'pass', (dx / dist) * speed, lofted ? PASS.loftLift : PASS.lift, (dz / dist) * speed, 0, mate.id);
  emit(w, { type: 'pass', player: p.id, team: p.team, target: mate.id });
}

function tackle(w: World, p: Player): void {
  const b = w.ball;
  p.tackleCooldown = PLAYER.tackleCooldown;
  p.vx += Math.cos(p.facing) * PLAYER.tackleLunge;
  p.vz += Math.sin(p.facing) * PLAYER.tackleLunge;
  const d = Math.hypot(b.x - p.x, b.z - p.z);

  if (b.owner >= 0) {
    const victim = w.players[b.owner];
    if (victim.team !== p.team && d < PLAYER.tackleRange && !isBehind(p, victim)) {
      victim.stun = PLAYER.stunTime;
      victim.charging = false;
      victim.charge = 0;
      takeBall(w, p);
      addRush(w, p.team, RUSH.steal);
      emit(w, { type: 'tackle', player: p.id, team: p.team, target: victim.id });
      return;
    }
  } else if (d < PLAYER.tackleRange && b.y < 1) {
    takeBall(w, p);
    return;
  }
  p.stun = PLAYER.missStun; // a missed lunge leaves you off balance
}

/** True when `tackler` is coming from behind `carrier`. Tackles from behind always miss. */
export function isBehind(tackler: Player, carrier: Player): boolean {
  const dx = tackler.x - carrier.x;
  const dz = tackler.z - carrier.z;
  const along = dx * Math.cos(carrier.facing) + dz * Math.sin(carrier.facing);
  return along < -0.3 * Math.hypot(dx, dz);
}

function takeBall(w: World, p: Player): void {
  const b = w.ball;
  const prev = b.lastKick;
  if (prev.kind === 'pass' && prev.by >= 0 && prev.by !== p.id && w.players[prev.by].team === p.team) {
    addRush(w, p.team, RUSH.pass);
    emit(w, { type: 'received', player: p.id, team: p.team });
  }
  if (prev.kind === 'shot' && prev.by >= 0 && w.players[prev.by].team !== p.team && p.role === 'keeper') {
    emit(w, { type: 'save', player: p.id, team: p.team });
  }
  b.owner = p.id;
  b.lastTouch = p.id;
  b.lastKick = { by: -1, kind: 'none', target: -1 };
  b.spin = 0;
  b.power = false;
  emit(w, { type: 'possession', player: p.id, team: p.team });
}

// --- ball -------------------------------------------------------------------

/**
 * One tick of a loose ball's flight (gravity, curl, bounces off walls and posts) without any
 * players touching it. The browser uses this to show your own kicks before the server confirms.
 */
export function flyLooseBall(w: World): void {
  if (w.ball.owner < 0) updateBall(w);
}

function updateBall(w: World): void {
  const b = w.ball;
  const r = BALL.radius;

  if (b.owner >= 0) {
    // Dribbling: the ball sits just in front of the player's feet.
    const o = w.players[b.owner];
    const carried = carriedBallPosition(o);
    b.x = carried.x;
    b.z = clamp(carried.z, -HALF_W + r, HALF_W - r);
    if (Math.abs(b.z) >= GOAL_HALF - r) b.x = clamp(b.x, -HALF_L + r, HALF_L - r);
    b.y = r;
    b.vx = o.vx;
    b.vy = 0;
    b.vz = o.vz;
    b.spin = 0;
    checkGoal(w);
    return;
  }

  b.vy -= BALL.gravity * DT;

  const hs = Math.hypot(b.vx, b.vz);
  if (hs > 0.5 && b.spin !== 0) {
    // Curl: push sideways, perpendicular to the direction of travel.
    const nx = -b.vz / hs;
    const nz = b.vx / hs;
    const a = b.spin * BALL.curlStrength * DT;
    b.vx += nx * a;
    b.vz += nz * a;
  }
  b.spin *= Math.max(0, 1 - BALL.spinDecay * DT);

  const drag = Math.max(0, 1 - BALL.airDrag * DT);
  b.vx *= drag;
  b.vz *= drag;

  b.x += b.vx * DT;
  b.y += b.vy * DT;
  b.z += b.vz * DT;

  if (b.y < r) {
    b.y = r;
    if (b.vy < -BALL.minBounceSpeed) {
      emit(w, { type: 'bounce', strength: -b.vy });
      b.vy = -b.vy * BALL.bounce;
    } else {
      b.vy = 0;
    }
  }
  if (b.y <= r + 1e-4 && b.vy === 0) {
    const f = Math.max(0, 1 - BALL.groundFriction * DT);
    b.vx *= f;
    b.vz *= f;
    b.spin *= Math.max(0, 1 - BALL.groundSpinDecay * DT);
    if (Math.hypot(b.vx, b.vz) < 0.05) {
      b.vx = 0;
      b.vz = 0;
    }
  }
  if (b.y > PITCH.ceiling - r) {
    b.y = PITCH.ceiling - r;
    b.vy = -Math.abs(b.vy) * 0.5;
  }

  collideBallWithArena(w);
  checkGoal(w);
}

function collideBallWithArena(w: World): void {
  const b = w.ball;
  const r = BALL.radius;

  // Side walls of the cage.
  if (Math.abs(b.z) > HALF_W - r) {
    const s = Math.sign(b.z);
    b.z = s * (HALF_W - r);
    if (b.vz * s > 0) {
      emit(w, { type: 'wall', strength: Math.abs(b.vz) });
      b.vz = -b.vz * BALL.wallBounce;
    }
  }

  const sx = Math.sign(b.x) || 1;
  const ax = Math.abs(b.x);
  if (ax > HALF_L) {
    // Inside the goal: side netting, roof netting and back of the net.
    const maxZ = GOAL_HALF - r;
    if (Math.abs(b.z) > maxZ) {
      b.z = Math.sign(b.z) * maxZ;
      b.vz = -b.vz * BALL.netBounce;
    }
    if (b.y > PITCH.goalHeight - r) {
      b.y = PITCH.goalHeight - r;
      if (b.vy > 0) b.vy = -b.vy * BALL.netBounce;
    }
    const back = HALF_L + PITCH.goalDepth - r;
    if (ax > back) {
      b.x = sx * back;
      if (b.vx * sx > 0) {
        emit(w, { type: 'net', strength: Math.abs(b.vx) });
        b.vx = -b.vx * BALL.netBounce;
      }
    }
  } else if (ax > HALF_L - r) {
    const inMouth = Math.abs(b.z) < GOAL_HALF && b.y < PITCH.goalHeight;
    if (!inMouth) {
      b.x = sx * (HALF_L - r);
      if (b.vx * sx > 0) {
        emit(w, { type: 'wall', strength: Math.abs(b.vx) });
        b.vx = -b.vx * BALL.wallBounce;
      }
    }
  }

  // Posts (vertical) and crossbars (horizontal).
  for (const ex of [-HALF_L, HALF_L]) {
    if (b.y < PITCH.goalHeight) {
      for (const pz of [-GOAL_HALF, GOAL_HALF]) bounceOffBar(w, b.x - ex, b.z - pz, 'xz');
    }
    if (Math.abs(b.z) < GOAL_HALF) bounceOffBar(w, b.x - ex, b.y - PITCH.goalHeight, 'xy');
  }
}

/** Bounces the ball off a round bar. `da`/`db` are the ball's offset from the bar's centre line. */
function bounceOffBar(w: World, da: number, db: number, plane: 'xz' | 'xy'): void {
  const b = w.ball;
  const min = BALL.radius + PITCH.postRadius;
  const d = Math.hypot(da, db);
  if (d >= min || d < 1e-6) return;
  const na = da / d;
  const nb = db / d;
  const push = min - d;
  b.x += na * push;
  const vb = plane === 'xz' ? b.vz : b.vy;
  const vn = b.vx * na + vb * nb;
  if (plane === 'xz') b.z += nb * push;
  else b.y += nb * push;
  if (vn >= 0) return;
  const k = (1 + BALL.postBounce) * vn;
  b.vx -= k * na;
  if (plane === 'xz') b.vz -= k * nb;
  else b.vy -= k * nb;
  emit(w, { type: 'post', strength: -vn });
}

function checkGoal(w: World): void {
  const b = w.ball;
  if (w.phase !== 'playing' || w.mode === 'penalties') return; // penalties judge their own goals
  if (Math.abs(b.x) <= HALF_L + BALL.radius || Math.abs(b.z) >= GOAL_HALF || b.y >= PITCH.goalHeight) return;

  const team: Team = b.x > 0 ? 0 : 1;
  const scorer = b.lastTouch;
  if (b.owner >= 0) {
    // Dribbled in: let it roll into the net.
    const o = w.players[b.owner];
    b.owner = -1;
    b.vx = Math.cos(o.facing) * 4;
    b.vz = Math.sin(o.facing) * 4;
  }
  w.score[team]++;
  w.lastScorer = scorer;
  w.kickoffTeam = team === 0 ? 1 : 0;
  w.phase = 'goal';
  w.phaseTimer = MATCH.goalCelebration;
  for (const p of w.players) {
    p.charging = false;
    p.charge = 0;
  }
  emit(w, {
    type: 'goal',
    team,
    player: scorer,
    ownGoal: scorer >= 0 && w.players[scorer].team !== team,
  });
}

/**
 * After a goal the scorer runs off toward the nearest corner of the end they scored at, and
 * teammates jog over to join them. Everyone else slows to a stop. (After an own goal, nobody runs.)
 */
function celebrate(w: World): void {
  const team: Team = w.kickoffTeam === 0 ? 1 : 0; // the team that conceded kicks off
  const scorer = w.players[w.lastScorer];
  const runner = scorer && scorer.team === team ? scorer : undefined;
  const steer = (p: Player, tx: number, tz: number, speed: number, stopAt: number) => {
    const dx = tx - p.x;
    const dz = tz - p.z;
    const d = Math.hypot(dx, dz);
    const v = d > stopAt ? Math.min(speed, (d - stopAt) * 3) : 0;
    p.vx = lerp(p.vx, d > 0 ? (dx / d) * v : 0, 0.12);
    p.vz = lerp(p.vz, d > 0 ? (dz / d) * v : 0, 0.12);
    if (Math.hypot(p.vx, p.vz) > 0.5) p.facing = Math.atan2(p.vz, p.vx);
  };
  for (const p of w.players) {
    if (runner && p === runner) {
      const end = attackDir(team) * (HALF_L - 2.5);
      steer(p, end, (p.z >= 0 ? 1 : -1) * (HALF_W - 2.5), PLAYER.speed, 0.3);
    } else if (runner && p.team === team && p.role !== 'keeper') {
      steer(p, runner.x, runner.z, PLAYER.speed * 0.8, 1.6);
    } else {
      p.vx *= 0.9;
      p.vz *= 0.9;
    }
    movePlayer(p);
  }
  separatePlayers(w);
}

/** Lets players pick up a loose ball, and makes the ball bounce off players who can't. */
function checkBallContacts(w: World): void {
  const b = w.ball;
  if (b.owner >= 0) return;

  let best: Player | undefined;
  let bestD = Infinity;
  for (const p of w.players) {
    if (p.stun > 0 || p.kickCooldown > 0) continue;
    const keeper = p.role === 'keeper' && inOwnBox(p);
    const d = Math.hypot(b.x - p.x, b.z - p.z);
    if (d > (keeper ? PLAYER.keeperReach : PLAYER.reach)) continue;
    if (b.y > (keeper ? PLAYER.keeperReachHeight : 1.1)) continue;
    const rel = Math.hypot(b.vx - p.vx, b.vz - p.vz);
    if (!keeper && rel > PLAYER.maxTrapSpeed) continue;
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  if (best) {
    takeBall(w, best);
    return;
  }

  // Nobody could control it: bounce off any body it hits.
  const min = PLAYER.radius + BALL.radius;
  for (const p of w.players) {
    if (b.y > 1.9) break;
    const dx = b.x - p.x;
    const dz = b.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d >= min || d < 1e-6) continue;
    const nx = dx / d;
    const nz = dz / d;
    b.x = p.x + nx * min;
    b.z = p.z + nz * min;
    const vn = (b.vx - p.vx) * nx + (b.vz - p.vz) * nz;
    if (vn < 0) {
      b.vx -= 1.4 * vn * nx;
      b.vz -= 1.4 * vn * nz;
      b.lastTouch = p.id;
      emit(w, { type: 'bounce', player: p.id, strength: -vn });
    }
  }
}

// --- penalty shootout ---------------------------------------------------------
// Five kicks each, alternating, then sudden death. Only the taker and the opposing keeper play;
// everyone else watches from the halfway line.

/** Who has won the shootout so far, or -1 if it isn't decided yet. */
export function shootoutWinner(kicks: readonly [readonly number[], readonly number[]], kicksEach: number = SHOOTOUT.kicksEach): Team | -1 {
  const [a, b] = kicks;
  const sa = a.reduce((n, k) => n + k, 0);
  const sb = b.reduce((n, k) => n + k, 0);
  if (a.length <= kicksEach && b.length <= kicksEach) {
    // Regulation: decided as soon as one side can't catch up with the kicks it has left.
    if (sa > sb + (kicksEach - b.length)) return 0;
    if (sb > sa + (kicksEach - a.length)) return 1;
    return -1;
  }
  // Sudden death: decided after each pair of kicks.
  if (a.length === b.length && sa !== sb) return sa > sb ? 0 : 1;
  return -1;
}

const attackerOf = (w: World, team: Team) => w.players.find((p) => p.team === team && p.role === 'attacker')!;
const keeperOf = (w: World, team: Team) => w.players.find((p) => p.team === team && p.role === 'keeper')!;

/** The player taking the current penalty, and the keeper facing it. */
export function penaltyDuel(w: World): { taker: Player; keeper: Player } | null {
  if (!w.shootout) return null;
  const t = w.shootout.taker;
  return { taker: attackerOf(w, t), keeper: keeperOf(w, t === 0 ? 1 : 0) };
}

function setupPenalty(w: World): void {
  const so = w.shootout!;
  const dir = attackDir(so.taker);
  const goalX = dir * HALF_L;
  const spotX = goalX - dir * SHOOTOUT.spotDistance;
  const { taker, keeper } = penaltyDuel(w)!;

  w.players.forEach((p, i) => {
    Object.assign(p, {
      vx: 0,
      vz: 0,
      stamina: 1,
      sprinting: false,
      charging: false,
      charge: 0,
      kickCooldown: 0,
      tackleCooldown: 0,
      stun: 0,
      dive: 0,
      prevShoot: false,
      prevPass: false,
      prevThrough: false,
      prevTackle: false,
    });
    // Spectators line up on the halfway line, away from the kick.
    p.x = -dir * (1 + (p.team === so.taker ? 0 : 1.5));
    p.z = -9 + (i % 3) * 2.5 + p.team * 7.5;
    p.facing = dir > 0 ? 0 : Math.PI;
  });
  Object.assign(taker, { x: spotX - dir * (PLAYER.radius + BALL.radius + 0.12), z: 0, facing: dir > 0 ? 0 : Math.PI });
  Object.assign(keeper, { x: goalX - dir * 0.6, z: 0, facing: dir > 0 ? Math.PI : 0 });

  Object.assign(w.ball, makeBall(), { x: spotX, z: 0, owner: taker.id, lastTouch: taker.id });
  so.kicked = false;
  so.kickTimer = 0;
  w.phase = 'kickoff';
  w.phaseTimer = SHOOTOUT.setupTime;
  emit(w, { type: 'penaltySetup', team: so.taker, player: taker.id });
}

function stepShootout(w: World, inputs: ReadonlyArray<Input | undefined>): void {
  const so = w.shootout!;
  switch (w.phase) {
    case 'fulltime':
      return;
    case 'kickoff':
      w.phaseTimer -= DT;
      if (w.phaseTimer <= 0) {
        w.phase = 'playing';
        so.kickTimer = 0;
        emit(w, { type: 'whistle' });
      }
      return;
    case 'goal':
      // Showing the result: let the ball settle, then the next kick (or the end).
      w.phaseTimer -= DT;
      updateBall(w);
      if (w.phaseTimer <= 0) {
        if (w.winner !== -1) endMatch(w);
        else {
          so.taker = so.taker === 0 ? 1 : 0;
          setupPenalty(w);
        }
      }
      return;
    case 'playing':
      break;
  }

  so.kickTimer += DT;
  const { taker, keeper } = penaltyDuel(w)!;
  const takerInput = inputs[taker.id] ?? NO_INPUT;
  if (!so.kicked) {
    takePenalty(w, taker, takerInput);
    if (!so.kicked && so.kickTimer > SHOOTOUT.timeLimit) {
      // Took too long: a medium-power kick straight where they're aiming.
      taker.charge = PLAYER.maxCharge * 0.5;
      shoot(w, taker, 0);
      so.kicked = true;
      so.kickTimer = 0;
    }
  }
  rememberButtons(taker, takerInput);
  keepGoal(keeper, inputs[keeper.id] ?? NO_INPUT);

  updateBall(w);
  if (so.kicked) {
    keeperTouch(w, keeper);
    judgePenalty(w, taker, keeper);
  }
}

/** The taker stands still, turns to aim (within limits), and holds shoot for power. */
function takePenalty(w: World, p: Player, inp: Input): void {
  const so = w.shootout!;
  p.vx = 0;
  p.vz = 0;
  const straight = attackDir(p.team) > 0 ? 0 : Math.PI;
  if (!p.charging && Math.hypot(inp.moveX, inp.moveZ) > 0.15) {
    // Aim: once charging, the aim is locked and sideways input curls the shot instead.
    const wanted = Math.atan2(inp.moveZ, inp.moveX);
    const offset = clamp(wrapAngleTo(wanted, straight), -SHOOTOUT.aimLimit, SHOOTOUT.aimLimit);
    p.facing = turnTowards(p.facing, straight + offset, SHOOTOUT.aimTurnRate * DT);
  }
  if (inp.shoot) {
    p.charging = true;
    p.charge = Math.min(PLAYER.maxCharge, p.charge + DT);
  } else if (p.charging) {
    const lateral = -inp.moveX * Math.sin(p.facing) + inp.moveZ * Math.cos(p.facing);
    shoot(w, p, lateral);
    p.charging = false;
    p.charge = 0;
    so.kicked = true;
    so.kickTimer = 0;
  }
}

/** Angle difference `a - b`, wrapped to -PI..PI. */
function wrapAngleTo(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** The keeper shuffles along the goal line, and dives (tackle button) the way they're pushing. */
function keepGoal(p: Player, inp: Input): void {
  const dir = attackDir(p.team);
  const homeX = ownGoalX(p.team) + dir * 0.6;
  if (p.dive > 0) {
    p.dive = Math.max(0, p.dive - DT);
    p.vz *= 0.97;
    if (p.dive === 0) p.stun = SHOOTOUT.diveRecovery; // on the floor for a moment
  } else if (p.stun > 0) {
    p.stun = Math.max(0, p.stun - DT);
    p.vz *= 0.8;
  } else {
    const want = clamp(inp.moveZ, -1, 1) * SHOOTOUT.keeperLineSpeed;
    p.vz += clamp(want - p.vz, -PLAYER.accel * DT, PLAYER.accel * DT);
    if (inp.tackle && !p.prevTackle) {
      // Dive the way the stick is pushed; with no direction, a short spring upward (bigger reach).
      const side = Math.abs(inp.moveZ) > 0.2 ? Math.sign(inp.moveZ) : 0;
      p.dive = side === 0 ? SHOOTOUT.diveTime * 0.6 : SHOOTOUT.diveTime;
      p.vz = side * SHOOTOUT.diveSpeed;
    }
  }
  p.x = homeX;
  p.vx = 0;
  p.z = clamp(p.z + p.vz * DT, -GOAL_HALF - 0.5, GOAL_HALF + 0.5);
  p.facing = dir > 0 ? 0 : Math.PI;
  p.sprinting = false;
  rememberButtons(p, inp);
}

/** A keeper who reaches the ball holds it (a diving keeper reaches further). */
function keeperTouch(w: World, keeper: Player): void {
  const b = w.ball;
  if (b.owner >= 0) return;
  const reach = keeper.dive > 0 ? SHOOTOUT.diveReach : SHOOTOUT.standingReach;
  if (Math.hypot(b.x - keeper.x, b.z - keeper.z) < reach && b.y < PLAYER.keeperReachHeight) takeBall(w, keeper);
}

function judgePenalty(w: World, taker: Player, keeper: Player): void {
  const so = w.shootout!;
  const b = w.ball;
  const dir = attackDir(so.taker);
  const scored = Math.abs(b.x) > HALF_L + BALL.radius && Math.abs(b.z) < GOAL_HALF && b.y < PITCH.goalHeight && b.x * dir > 0;
  const saved = b.owner === keeper.id;
  // Wide: level with the goal line but outside the posts (e.g. off the post and along the wall).
  const wide = Math.abs(b.x) > HALF_L - 1 && Math.abs(b.z) > GOAL_HALF + BALL.radius;
  const missed =
    !scored &&
    !saved &&
    (wide ||
      (so.kickTimer > 0.25 && (b.vx * dir < -0.5 || Math.hypot(b.vx, b.vz) < 0.4)) ||
      so.kickTimer > SHOOTOUT.settleTime);
  if (!scored && !saved && !missed) return;

  so.kicks[so.taker].push(scored ? 1 : 0);
  if (scored) {
    w.score[so.taker]++;
    emit(w, { type: 'goal', team: so.taker, player: taker.id });
  } else if (!saved) {
    emit(w, { type: 'penaltyMiss', team: so.taker, player: taker.id }); // a save already announced itself
  }
  w.winner = shootoutWinner(so.kicks);
  w.phase = 'goal';
  w.phaseTimer = SHOOTOUT.resultTime;
}

