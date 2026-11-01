// Bots press the same "buttons" a human does: they only ever return an Input.
import { DT, PITCH, PLAYER } from './constants';
import { clamp, lerp, mulberry32, wrapAngle } from './math';
import { attackDir, bestPassTarget, isBehind, ownGoalX } from './sim';
import type { Input, Player, World } from './types';

export interface BotSkill {
  speedScale: number;
  shootRange: number; // starts shooting inside this distance from goal
  aimError: number; // metres of random miss on the target
  tackleChance: number; // chance per tick of tackling when close enough
  passPatience: number; // ticks of dribbling before looking for a pass
  keeperFocus: number; // 0..1, how well the keeper tracks shots
}

export const BOT_SKILLS = {
  easy: { speedScale: 0.88, shootRange: 11, aimError: 1.8, tackleChance: 0.015, passPatience: 160, keeperFocus: 0.55 },
  normal: { speedScale: 0.97, shootRange: 13, aimError: 1.0, tackleChance: 0.035, passPatience: 110, keeperFocus: 0.9 },
  hard: { speedScale: 1.04, shootRange: 15, aimError: 0.5, tackleChance: 0.08, passPatience: 75, keeperFocus: 0.95 },
} satisfies Record<string, BotSkill>;

export type Difficulty = keyof typeof BOT_SKILLS;

const HALF_L = PITCH.length / 2;
const HALF_W = PITCH.width / 2;
const GOAL_HALF = PITCH.goalWidth / 2;

export class Bot {
  private shootTicks = 0;
  private aimZ = 0;
  private possessionTicks = 0;
  private lastPass = false;
  private lastTackle = false;
  private readonly rng: () => number;

  constructor(
    readonly playerId: number,
    public skill: BotSkill,
    seed = 0,
  ) {
    this.rng = mulberry32(playerId * 7919 + 17 + seed * 104729);
  }

  /** Forget any half-finished action, e.g. when a human takes over this player. */
  reset(): void {
    this.shootTicks = 0;
    this.possessionTicks = 0;
    this.lastPass = false;
    this.lastTackle = false;
  }

  /** `humanIds` are players controlled by people; bots leave chasing to them when they are closest. */
  think(w: World, humanIds: ReadonlySet<number> = new Set()): Input {
    const out: Input = { moveX: 0, moveZ: 0, sprint: false, shoot: false, pass: false, tackle: false };
    if (w.phase !== 'playing') {
      this.reset();
      return out;
    }
    const p = w.players[this.playerId];
    const hasBall = w.ball.owner === p.id;
    this.possessionTicks = hasBall ? this.possessionTicks + 1 : 0;

    if (this.shootTicks > 0) {
      if (hasBall) {
        this.shootTicks--;
        steer(out, p, attackDir(p.team) * HALF_L, this.aimZ, 0.1);
        out.shoot = this.shootTicks > 0; // letting go fires the shot
        return this.finish(out);
      }
      this.shootTicks = 0;
    }

    if (p.role === 'keeper') this.keeper(w, p, out);
    else if (hasBall) this.withBall(w, p, out);
    else this.withoutBall(w, p, out, humanIds);
    return this.finish(out);
  }

  private finish(out: Input): Input {
    // Buttons only count when newly pressed, so never hold pass/tackle for two ticks.
    if (out.pass && this.lastPass) out.pass = false;
    if (out.tackle && this.lastTackle) out.tackle = false;
    this.lastPass = out.pass;
    this.lastTackle = out.tackle;
    return out;
  }

  private withBall(w: World, p: Player, out: Input): void {
    if (w.kickoffPending) {
      // Taking a kickoff: a short pause, then pass to a teammate.
      if (this.possessionTicks > 40) out.pass = true;
      return;
    }
    const dir = attackDir(p.team);
    const goalX = dir * HALF_L;
    const distGoal = Math.hypot(goalX - p.x, p.z);
    const opp = nearestOpponent(w, p);
    const oppDist = opp ? Math.hypot(opp.x - p.x, opp.z - p.z) : Infinity;

    if (distGoal < this.skill.shootRange && Math.abs(p.z) < 9) {
      // Aim for the corner the keeper is furthest from.
      const keeper = w.players.find((q) => q.team !== p.team && q.role === 'keeper');
      const kz = keeper ? keeper.z : 0;
      const side = kz > 0.2 ? -1 : kz < -0.2 ? 1 : p.z >= 0 ? -1 : 1;
      const aimZ = side * (GOAL_HALF - 0.8);
      steer(out, p, goalX, aimZ, 0.1);
      const aimAngle = Math.atan2(aimZ - p.z, goalX - p.x);
      if (Math.abs(wrapAngle(aimAngle - p.facing)) < 0.35) {
        this.aimZ = aimZ + (this.rng() - 0.5) * 2 * this.skill.aimError;
        const power = clamp(distGoal / this.skill.shootRange, 0.3, 1);
        this.shootTicks = Math.max(2, Math.round((power * PLAYER.maxCharge) / DT));
        out.shoot = true;
      }
      return;
    }

    if (oppDist < 2.4 || this.possessionTicks > this.skill.passPatience) {
      const choice = bestPassTarget(w, p, 0.3);
      if (choice && choice.score > 1) {
        out.pass = true;
        return;
      }
    }

    // Dribble toward goal, sidestepping the nearest defender.
    let tx = goalX - dir * 2;
    let tz = p.z * 0.6;
    if (opp && oppDist < 4 && (opp.x - p.x) * dir > 0) {
      tz = p.z + (p.z >= opp.z ? 4 : -4);
      tx = p.x + dir * 3;
    }
    steer(out, p, tx, clamp(tz, -HALF_W + 1.5, HALF_W - 1.5), 0.1);
    out.sprint = oppDist > 3 && p.stamina > 0.4;
  }

  private withoutBall(w: World, p: Player, out: Input, humanIds: ReadonlySet<number>): void {
    const b = w.ball;
    const dir = attackDir(p.team);
    const owner = b.owner >= 0 ? w.players[b.owner] : undefined;

    if (owner && owner.team === p.team) {
      // Support the teammate on the ball: get ahead and into a passing lane.
      const lane = owner.z > 0 ? -1 : 1;
      const tx = p.role === 'attacker' ? owner.x + dir * 7 : owner.x - dir * 4;
      const tz = p.role === 'attacker' ? lane * 5 : lane * 3;
      steer(out, p, clamp(tx, -HALF_L + 3, HALF_L - 3), tz, 1.5);
      out.sprint = p.role === 'attacker' && p.stamina > 0.6;
      return;
    }

    const px = b.x + b.vx * 0.3;
    const pz = b.z + b.vz * 0.3;
    if (closestOutfielder(w, p, px, pz) === p.id || humanIsFarther(w, p, px, pz, humanIds)) {
      steer(out, p, px, pz, 0.2);
      const d = Math.hypot(b.x - p.x, b.z - p.z);
      out.sprint = d > 3 && p.stamina > 0.3;
      if (
        owner &&
        d < PLAYER.tackleRange * 0.85 &&
        p.tackleCooldown <= 0 &&
        !isBehind(p, owner) &&
        this.rng() < this.skill.tackleChance
      ) {
        out.tackle = true;
      }
      return;
    }

    // Hold a defensive shape between the ball and our goal.
    const goal = ownGoalX(p.team);
    const t = p.role === 'attacker' ? 0.35 : 0.55;
    // Offsets are multiplied by `dir` so both teams use the same shape, mirrored.
    const tz = clamp(b.z * 0.5 + (p.role === 'attacker' ? 3 : -3) * dir, -HALF_W + 2, HALF_W - 2);
    steer(out, p, lerp(b.x, goal, t), tz, 1.5);
  }

  private keeper(w: World, p: Player, out: Input): void {
    const b = w.ball;
    const dir = attackDir(p.team);
    const goal = ownGoalX(p.team);
    const homeX = goal + dir * 1.3;

    if (b.owner === p.id) {
      // Holding the ball: wait a moment, then distribute.
      steer(out, p, homeX + dir * 2, 0, 1);
      if (this.possessionTicks > 25) out.pass = true;
      return;
    }

    let tx = homeX;
    let tz = clamp(b.z * 0.4, -GOAL_HALF + 0.6, GOAL_HALF - 0.6);

    // Shot coming: predict where it crosses our line and get there.
    if (b.owner < 0 && b.vx * dir < -6) {
      const t = (homeX - b.x) / b.vx;
      if (t > 0 && t < 1.5) {
        const guess = b.z + b.vz * t;
        tz = clamp(lerp(tz, guess, this.skill.keeperFocus), -GOAL_HALF - 0.3, GOAL_HALF + 0.3);
        out.sprint = true;
      }
    }

    const inBox = Math.abs(b.x - goal) < PITCH.boxDepth && Math.abs(b.z) < PITCH.boxHalfWidth;
    const owner = b.owner >= 0 ? w.players[b.owner] : undefined;
    if (inBox && b.owner < 0 && Math.hypot(b.vx, b.vz) < 10) {
      tx = b.x;
      tz = b.z;
      out.sprint = true;
    } else if (inBox && owner && owner.team !== p.team) {
      tx = b.x;
      tz = b.z;
      if (Math.hypot(b.x - p.x, b.z - p.z) < PLAYER.tackleRange * 0.8 && p.tackleCooldown <= 0 && !isBehind(p, owner)) {
        out.tackle = true;
      }
    }
    steer(out, p, tx, tz, 0.6);
  }
}

function steer(out: Input, p: Player, tx: number, tz: number, arrive: number): void {
  const dx = tx - p.x;
  const dz = tz - p.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.15) return;
  const s = Math.min(1, d / Math.max(arrive, 0.01));
  out.moveX = (dx / d) * s;
  out.moveZ = (dz / d) * s;
}

function nearestOpponent(w: World, p: Player): Player | undefined {
  let best: Player | undefined;
  let bestD = Infinity;
  for (const q of w.players) {
    if (q.team === p.team) continue;
    const d = Math.hypot(q.x - p.x, q.z - p.z);
    if (d < bestD) {
      best = q;
      bestD = d;
    }
  }
  return best;
}

/** Id of the team's outfield player nearest the point (humans included). */
function closestOutfielder(w: World, p: Player, x: number, z: number): number {
  let best = -1;
  let bestD = Infinity;
  for (const q of w.players) {
    if (q.team !== p.team || q.role === 'keeper') continue;
    const d = Math.hypot(q.x - x, q.z - z);
    if (d < bestD) {
      best = q.id;
      bestD = d;
    }
  }
  return best;
}

/** True when a human teammate is nearest but clearly not going for the ball, so this bot should. */
function humanIsFarther(w: World, p: Player, x: number, z: number, humanIds: ReadonlySet<number>): boolean {
  const closest = closestOutfielder(w, p, x, z);
  if (!humanIds.has(closest)) return false;
  const h = w.players[closest];
  const hd = Math.hypot(h.x - x, h.z - z);
  const md = Math.hypot(p.x - x, p.z - z);
  return hd > 6 && md < hd + 2;
}
