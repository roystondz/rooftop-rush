// Decides when the crowd reacts: a rising "ooh" as a shot heads for goal, a groan when it goes
// just wide, a murmur when an attacker carries the ball into the box, clapping for the last
// 30 seconds and applause at full time. It only decides; Effects plays the sounds. Every reaction
// is short: there is no constant crowd noise (it used to sound like a buzz).
import { BALL, PITCH } from '../shared/constants';
import { attackDir } from '../shared/sim';
import type { MatchEvent, World } from '../shared/types';

export type Reaction = 'rise' | 'groan' | 'murmur' | 'finale' | 'applause';

const HALF_L = PITCH.length / 2;
const GOAL_HALF = PITCH.goalWidth / 2;
/** A shot counts as "on its way" for this many ticks; after that it's forgotten. */
const SHOT_WINDOW = 100;
/** At most one murmur per this many ticks. */
const MURMUR_GAP = 300;
/** Clapping starts when this many seconds are left. */
const FINALE_AT = 30;

export class Crowd {
  /** Tick of the last shot heading for goal that hasn't been settled yet (or -1). */
  private shotAt = -1;
  private lastMurmur = -Infinity;
  private carrierInBox = false;
  private finaleDone = false;

  reset(): void {
    this.shotAt = -1;
    this.lastMurmur = -Infinity;
    this.carrierInBox = false;
    this.finaleDone = false;
  }

  event(w: World, e: MatchEvent): Reaction[] {
    switch (e.type) {
      case 'shot':
      case 'powerShot':
        if (w.mode !== 'match' || e.player === undefined || !headingForGoal(w, w.players[e.player].team)) return [];
        this.shotAt = w.tick;
        return ['rise'];
      case 'goal':
      case 'save':
      case 'post':
      case 'possession':
        this.shotAt = -1; // settled: the goal, save and post have their own sounds
        return [];
      case 'fulltime':
        return ['applause'];
      default:
        return [];
    }
  }

  /** Call once per tick (or snapshot) with the current world. */
  watch(w: World): Reaction[] {
    if (w.mode !== 'match') return [];
    const out: Reaction[] = [];
    if (w.phase !== 'playing') {
      this.shotAt = -1;
      this.carrierInBox = false;
      return out;
    }
    const b = w.ball;

    // A shot that went just wide of the post, along or past the goal line.
    if (this.shotAt >= 0) {
      const wide = Math.abs(b.z) - GOAL_HALF;
      if (Math.abs(b.x) > HALF_L - BALL.radius * 2 && wide > 0.05 && wide < 3) {
        out.push('groan');
        this.shotAt = -1;
      } else if (w.tick - this.shotAt > SHOT_WINDOW) {
        this.shotAt = -1;
      }
    }

    // An attacker carrying the ball into the other team's box.
    const carrier = b.owner >= 0 ? w.players[b.owner] : undefined;
    const inBox =
      !!carrier &&
      carrier.x * attackDir(carrier.team) > HALF_L - PITCH.boxDepth &&
      Math.abs(carrier.z) < PITCH.boxHalfWidth;
    if (inBox && !this.carrierInBox && w.tick - this.lastMurmur > MURMUR_GAP) {
      out.push('murmur');
      this.lastMurmur = w.tick;
    }
    this.carrierInBox = inBox;

    if (!this.finaleDone && !w.goldenGoal && w.time <= FINALE_AT && w.time > 0) {
      this.finaleDone = true;
      out.push('finale');
    }
    return out;
  }
}

/** Is the ball, just kicked by `team`, travelling toward the goal it attacks and roughly on target? */
export function headingForGoal(w: World, team: 0 | 1): boolean {
  const b = w.ball;
  const dir = attackDir(team);
  if (b.vx * dir <= 1) return false;
  const goalX = dir * HALF_L;
  const t = (goalX - b.x) / b.vx;
  if (t > 1.6) return false; // too far out to get excited about
  const zAtLine = b.z + b.vz * t;
  return Math.abs(zAtLine) < GOAL_HALF + 1.5;
}
