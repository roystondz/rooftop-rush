// Bots press the same "buttons" a human does: they only ever return an Input.
import { BALL, DT, PASS, PITCH, PLAYER, SHOT } from './constants';
import { clamp, lerp, mulberry32, wrapAngle } from './math';
import { attackDir, bestPassTarget, canHead, isBehind, ownGoalX, penaltyDuel } from './sim';
import type { Input, Player, World } from './types';

export interface BotSkill {
  speedScale: number;
  shootRange: number; // starts shooting inside this distance from goal
  aimError: number; // metres of random miss on the target
  tackleChance: number; // chance per tick of tackling when close enough
  passPatience: number; // ticks of dribbling before looking for a pass
  keeperFocus: number; // 0..1, how well the keeper tracks shots
  headerChance: number; // chance per tick of going for a header when the ball is there
  skillChance: number; // chance of trying a skill move when a defender closes in (decided once each time)
  chipChance: number; // chance of chipping a keeper who is well off their line
  crossChance: number; // chance per tick of crossing from out wide when a teammate is in the box
}

export const BOT_SKILLS = {
  easy: { speedScale: 0.88, shootRange: 11, aimError: 1.8, tackleChance: 0.015, passPatience: 160, keeperFocus: 0.55, headerChance: 0.25, skillChance: 0.15, crossChance: 0.02, chipChance: 0.15 },
  normal: { speedScale: 0.97, shootRange: 13, aimError: 1.0, tackleChance: 0.035, passPatience: 110, keeperFocus: 0.9, headerChance: 0.5, skillChance: 0.3, crossChance: 0.04, chipChance: 0.3 },
  hard: { speedScale: 1.04, shootRange: 15, aimError: 0.5, tackleChance: 0.08, passPatience: 75, keeperFocus: 0.95, headerChance: 0.8, skillChance: 0.45, crossChance: 0.06, chipChance: 0.45 },
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
  private lastSkill = false;
  /** Whether we've already decided about a skill move against the defender closing in now. */
  private challenged = false;
  private lastShootTap = false;
  /** The shot being charged is a chip. */
  private chipping = false;
  /** Penalty plans, decided once per kick. */
  private pen: {
    aimZ: number;
    power: number;
    wait: number;
    guess: number;
    reacted: boolean;
    swaySpeed: number; // keeper: how fast they shuffle side to side before the kick
    swayPhase: number;
    swaySize: number;
  } | null = null;
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
    this.pen = null;
  }

  /** `humanIds` are players controlled by people; bots leave chasing to them when they are closest. */
  think(w: World, humanIds: ReadonlySet<number> = new Set()): Input {
    const out: Input = { moveX: 0, moveZ: 0, sprint: false, shoot: false, pass: false, tackle: false };
    if (w.phase !== 'playing') {
      this.reset();
      return out;
    }
    const p = w.players[this.playerId];
    if (w.mode === 'penalties') {
      this.penalty(w, p, out);
      return this.finish(out);
    }
    const hasBall = w.ball.owner === p.id;
    this.possessionTicks = hasBall ? this.possessionTicks + 1 : 0;

    if (this.shootTicks > 0) {
      if (hasBall) {
        this.shootTicks--;
        steer(out, p, attackDir(p.team) * HALF_L, this.aimZ, 0.1);
        out.shoot = this.shootTicks > 0; // letting go fires the shot
        out.lob = this.chipping;
        return this.finish(out);
      }
      this.shootTicks = 0;
    }
    this.chipping = false;

    // Defending in your own half, bots are less sure-headed, so crosses are worth trying.
    const headerChance = this.skill.headerChance * (p.x * attackDir(p.team) < 0 ? 0.4 : 1);
    if (canHead(w, p) && this.rng() < headerChance) {
      this.header(p, out);
      return this.finish(out);
    }

    if (p.role === 'keeper') this.keeper(w, p, out);
    else if (hasBall) this.withBall(w, p, out);
    else this.withoutBall(w, p, out, humanIds);
    return this.finish(out);
  }

  /** Taking a penalty: pick a corner, aim, charge, shoot. Saving one: guess early or react late. */
  private penalty(w: World, p: Player, out: Input): void {
    const duel = penaltyDuel(w);
    const so = w.shootout;
    if (!duel || !so) return;
    if (!this.pen) {
      this.pen = {
        aimZ: (this.rng() < 0.5 ? -1 : 1) * (GOAL_HALF - 0.9) + (this.rng() - 0.5) * 2 * this.skill.aimError * 0.6,
        power: 0.55 + this.rng() * 0.4,
        wait: 25 + Math.floor(this.rng() * 50),
        // How likely the keeper is to commit to a side as the kick is struck (instead of reacting).
        guess: this.rng() < 0.5 ? (this.rng() < 0.5 ? -1 : 1) : 0,
        reacted: false,
        swaySpeed: 1.6 + this.rng() * 1.6,
        swayPhase: this.rng() * Math.PI * 2,
        swaySize: 0.5 + this.rng() * 0.6,
      };
    }
    const plan = this.pen;
    const b = w.ball;

    if (p.id === duel.taker.id && !so.kicked) {
      if (plan.wait-- > 0) return;
      const goalX = attackDir(p.team) * HALF_L;
      const dx = goalX - b.x;
      const dz = plan.aimZ - b.z;
      const aim = Math.atan2(dz, dx);
      if (this.shootTicks > 0) {
        this.shootTicks--;
        out.shoot = this.shootTicks > 0; // letting go fires it
        return;
      }
      if (Math.abs(wrapAngle(aim - p.facing)) > 0.04) {
        out.moveX = Math.cos(aim);
        out.moveZ = Math.sin(aim);
        return;
      }
      this.shootTicks = Math.max(2, Math.round((plan.power * PLAYER.maxCharge) / DT));
      out.shoot = true;
      return;
    }

    if (p.id === duel.keeper.id) {
      if (!so.kicked) {
        // Stay alive on the line: shuffle side to side, and lean a little toward where the taker
        // is aiming (sharper keepers read it better). Never the same spot twice.
        const sway = Math.sin(so.kickTimer * plan.swaySpeed + plan.swayPhase) * plan.swaySize;
        // Where the taker's aim line crosses our goal line (works from either end).
        const fx = Math.cos(duel.taker.facing);
        const along = Math.abs(fx) > 0.2 ? (p.x - duel.taker.x) / fx : 0;
        const aimedAt = duel.taker.z + Math.sin(duel.taker.facing) * along;
        const read = clamp(aimedAt, -2.5, 2.5) * this.skill.keeperFocus * 0.12;
        const target = clamp(sway + read, -1.8, 1.8);
        out.moveZ = clamp((target - p.z) * 1.5, -1, 1) * 0.8;
        return;
      }
      if (plan.reacted) return;
      if (plan.guess !== 0) {
        // Committed early to a side.
        out.moveZ = plan.guess;
        out.tackle = true;
        plan.reacted = true;
        return;
      }
      // Reacting: wait a moment (sharper keepers react sooner), then dive toward the shot.
      // Humans need roughly 0.2 s to react, so most saves come from guessing the right side.
      const reaction = 0.12 + (1 - this.skill.keeperFocus) * 0.4;
      if (so.kickTimer < reaction || Math.abs(b.vx) < 1) return;
      const t = (p.x - b.x) / b.vx;
      const zAt = t > 0 ? b.z + b.vz * t : b.z;
      if (Math.abs(zAt - p.z) > 0.6) {
        out.moveZ = Math.sign(zAt - p.z);
        out.tackle = true;
      } else {
        out.tackle = true; // straight at them: spring up
      }
      plan.reacted = true;
    }
  }

  private finish(out: Input): Input {
    // Buttons only count when newly pressed, so never hold pass/tackle for two ticks.
    if (out.pass && this.lastPass) out.pass = false;
    if (out.tackle && this.lastTackle) out.tackle = false;
    if (out.skill && this.lastSkill) out.skill = false;
    this.lastPass = out.pass;
    this.lastTackle = out.tackle;
    this.lastSkill = !!out.skill;
    return out;
  }

  /**
   * The ball is at head height: in the attacking half, head it at goal (aiming for a corner);
   * further back, head it clear, up the pitch.
   */
  private header(p: Player, out: Input): void {
    const dir = attackDir(p.team);
    const goalX = dir * HALF_L;
    if (p.x * dir > 0) {
      const aimZ = (p.z >= 0 ? -1 : 1) * (GOAL_HALF - 1) + (this.rng() - 0.5) * 2 * this.skill.aimError;
      const dx = goalX - p.x;
      const dz = aimZ - p.z;
      const d = Math.hypot(dx, dz);
      out.moveX = dx / d;
      out.moveZ = dz / d;
    } else {
      out.moveX = dir;
      out.moveZ = p.z >= 0 ? 0.4 : -0.4; // away from the middle of your own goal
    }
    // A fresh press each time (holding shoot would only work once).
    out.shoot = !this.lastShootTap;
    this.lastShootTap = out.shoot;
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
        let power = clamp(distGoal / this.skill.shootRange, 0.3, 1);
        // Keeper well off their line: sometimes chip them, charged to come down just under the bar.
        const keeperOut = keeper ? Math.abs(keeper.x - goalX) : 0;
        this.chipping = keeperOut > 3 && distGoal > 7 && distGoal < 15 && this.rng() < this.skill.chipChance;
        if (this.chipping) {
          const flight = (2 * SHOT.chipLift) / BALL.gravity;
          power = clamp((distGoal / flight - SHOT.chipMinSpeed) / (SHOT.chipMaxSpeed - SHOT.chipMinSpeed), 0, 1);
        }
        this.shootTicks = Math.max(2, Math.round((power * PLAYER.maxCharge) / DT));
        out.shoot = true;
        out.lob = this.chipping;
      }
      return;
    }

    // Out wide near goal with a teammate in the box: cross it in for a header.
    const wide = Math.abs(p.z) > PITCH.boxHalfWidth - 0.5 && p.x * dir > HALF_L - 14;
    if (wide && this.rng() < this.skill.crossChance) {
      const inBox = w.players.some(
        (q) => q.team === p.team && q.id !== p.id && q.x * dir > HALF_L - PITCH.boxDepth - 1 && Math.abs(q.z) < PITCH.boxHalfWidth,
      );
      if (inBox) {
        out.pass = true;
        out.lob = true; // a cross
        return;
      }
    }

    if (oppDist < 2.4 || this.possessionTicks > this.skill.passPatience) {
      const choice = bestPassTarget(w, p, 0.3);
      if (choice && choice.score > 1) {
        out.pass = true;
        // Long passes go in the air, over anyone in the way.
        out.lob = Math.hypot(choice.player.x - p.x, choice.player.z - p.z) > PASS.loftDistance;
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
    // A defender closing in from the front: sometimes try a step-over to get past (decided once).
    const closing = !!opp && oppDist < 2.2 && (opp.x - p.x) * dir > 0;
    if (closing && !this.challenged) {
      this.challenged = true;
      if (p.skillCooldown <= 0 && this.rng() < this.skill.skillChance) out.skill = true;
    }
    if (oppDist > 3.5) this.challenged = false;
  }

  private withoutBall(w: World, p: Player, out: Input, humanIds: ReadonlySet<number>): void {
    const b = w.ball;
    const dir = attackDir(p.team);
    const owner = b.owner >= 0 ? w.players[b.owner] : undefined;

    if (!owner && b.lastKick.kind === 'pass' && b.lastKick.target === p.id && b.y > 1) {
      // A ball in the air meant for me (a cross): get under it, where it comes down to head height.
      const spot = headHeightSpot(b);
      steer(out, p, spot.x, spot.z, 0.2);
      out.sprint = p.stamina > 0.2;
      return;
    }

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
      if (this.possessionTicks > 25) {
        out.pass = true;
        // A long throw-out goes over the top; a short one is rolled out.
        const target = bestPassTarget(w, p, 0.3)?.player;
        out.lob = !!target && Math.hypot(target.x - p.x, target.z - p.z) > PASS.loftDistance;
      }
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

/** Where a ball in the air will be when it drops to about head height (ignores drag and curl). */
function headHeightSpot(b: World['ball']): { x: number; z: number } {
  const target = 1.7;
  const g = BALL.gravity;
  const disc = b.vy * b.vy + 2 * g * (b.y - target);
  const t = disc > 0 ? (b.vy + Math.sqrt(disc)) / g : 0;
  return { x: b.x + b.vx * t, z: b.z + b.vz * t };
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
