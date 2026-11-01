// Client-side prediction for the player you control online.
//
// Without it, pressing a key does nothing until the server has run your input and sent the
// result back (your ping plus about 100 ms). With it:
//   1. Every input you send is also applied here straight away, with the same movement code
//      the server uses, so your player responds instantly.
//   2. When a snapshot arrives, it says which of your inputs the server has used (`ack`).
//      We start again from the server's position and re-apply only the inputs it hasn't seen
//      yet. That's "reconciliation", and it keeps the prediction honest.
//   3. If the server disagrees (someone bumped into you), the difference is faded out over
//      a few frames instead of making your player jump.
import { DT, PLAYER } from './constants';
import { applySnapshot, type Snapshot } from './protocol';
import { createWorld, holdForKickoff, keepOutOfCentreCircle, moveWithInput } from './sim';
import type { Input, Player, World } from './types';

/** Corrections bigger than this are teleports (kickoff, goal reset): jump instead of sliding. */
const SNAP_DISTANCE = 2.5;
/** How quickly a correction fades away; higher is snappier. */
const SMOOTHING = 12;
/** Never keep more than two seconds of unconfirmed inputs. */
const MAX_PENDING = 120;

export class Predictor {
  /** Player id being predicted, or -1 before the first snapshot. */
  playerId = -1;
  /** Where we believe our player is right now. */
  readonly state: Player;
  /** Visual difference still being faded out after a correction. */
  offsetX = 0;
  offsetZ = 0;
  /** Size of the last correction in metres (shown in the debug readout). */
  lastCorrection = 0;

  private pending: { seq: number; input: Input }[] = [];
  private scratch: World = createWorld();
  private active = false;
  private hasBall = false;
  private takingKickoff = false;
  private keepOutOfCircle = false;

  constructor() {
    this.state = { ...this.scratch.players[0] };
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Where to draw our player: the prediction plus any correction still fading out. */
  get visualX(): number {
    return this.state.x + this.offsetX;
  }

  get visualZ(): number {
    return this.state.z + this.offsetZ;
  }

  /** Call for every input sent to the server. It takes effect here immediately. */
  addInput(seq: number, input: Input): void {
    this.pending.push({ seq, input });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    if (this.active) this.apply(input);
  }

  /** Call for every snapshot. `ack` is the newest of our inputs the server has used. */
  reconcile(s: Snapshot, ack: number, playerId: number): void {
    this.pending = this.pending.filter((p) => p.seq > ack);
    applySnapshot(this.scratch, s);
    const server = this.scratch.players[playerId];
    if (!server) {
      this.playerId = -1;
      return;
    }

    const shownX = this.visualX;
    const shownZ = this.visualZ;
    const predictedX = this.state.x;
    const predictedZ = this.state.z;
    const switched = playerId !== this.playerId;

    // Start from what the server says, then replay what it hasn't seen yet.
    Object.assign(this.state, server);
    this.playerId = playerId;
    this.hasBall = s.b[6] === playerId;
    this.active = s.phase === 'playing' && server.stun <= 0;
    this.takingKickoff = s.kickoffPending && this.hasBall;
    this.keepOutOfCircle = s.kickoffPending && server.team !== s.kickoffTeam;
    if (this.active) for (const p of this.pending) this.apply(p.input);

    if (switched) {
      // Now controlling someone else: nothing to smooth.
      this.offsetX = this.offsetZ = this.lastCorrection = 0;
      return;
    }
    this.lastCorrection = Math.hypot(this.state.x - predictedX, this.state.z - predictedZ);
    // Keep drawing where we were, and let decay() slide toward the corrected spot.
    this.offsetX = shownX - this.state.x;
    this.offsetZ = shownZ - this.state.z;
    if (Math.hypot(this.offsetX, this.offsetZ) > SNAP_DISTANCE) this.offsetX = this.offsetZ = 0;
  }

  /** Fades out corrections. Call once per frame. */
  decay(frameDt: number): void {
    const k = Math.exp(-SMOOTHING * frameDt);
    this.offsetX *= k;
    this.offsetZ *= k;
  }

  private apply(input: Input): void {
    if (this.takingKickoff) {
      holdForKickoff(this.state, input);
      return;
    }
    moveWithInput(this.state, input, this.hasBall);
    if (this.keepOutOfCircle) keepOutOfCentreCircle(this.state);
    // Mirror the server's charging rule: holding shoot charges, letting go resets.
    if (input.shoot) {
      this.state.charging = true;
      this.state.charge = Math.min(PLAYER.maxCharge, this.state.charge + DT);
    } else {
      this.state.charging = false;
      this.state.charge = 0;
    }
  }
}
