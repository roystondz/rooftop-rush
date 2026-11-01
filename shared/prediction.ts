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
import { createWorld, flyLooseBall, holdForKickoff, keepOutOfCentreCircle, moveWithInput, step } from './sim';
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
    // Penalties are a duel of two players on fixed spots; the server's word is used directly.
    this.active = s.phase === 'playing' && server.stun <= 0 && s.mode === 'match';
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

/**
 * Shows your own shots and passes straight away online. When the input you're about to send
 * would kick the ball, the same kick is run here on a copy of the latest snapshot, and the
 * ball's flight is simulated locally until the server's version takes over.
 */
export class KickPredictor {
  /** True while the locally predicted ball is the one being drawn. */
  active = false;
  /** Player who made the predicted kick. */
  kicker = -1;
  private scratch: World = createWorld();
  private age = 0;

  get ball(): { x: number; y: number; z: number } {
    const b = this.scratch.ball;
    return { x: b.x, y: b.y, z: b.z };
  }

  get power(): boolean {
    return this.scratch.ball.power;
  }

  /**
   * Call with each input just before sending it. `me` is your predicted player before this input.
   * Returns which kind of kick started, or null if this input doesn't kick the ball.
   */
  tryKick(latest: Snapshot, me: Player, input: Input, previous: Input): 'shot' | 'powerShot' | 'pass' | null {
    // Only when we have the ball in open play. (Kickoff rules are applied by running the real kick code below.)
    if (latest.phase !== 'playing' || latest.b[6] !== me.id) return null;
    const releasing = me.charging && !input.shoot;
    const passing = ((input.pass && !previous.pass) || (!!input.through && !previous.through)) && !me.charging;
    if (!releasing && !passing) return null;

    const w = this.scratch;
    applySnapshot(w, latest);
    Object.assign(w.players[me.id], me, {
      prevShoot: previous.shoot,
      prevPass: previous.pass,
      prevThrough: !!previous.through,
      prevTackle: previous.tackle,
      kickCooldown: 0,
      stun: 0,
    });
    w.ball.owner = me.id;
    w.ball.lastKick = { by: -1, kind: 'none', target: -1 };
    const inputs: Input[] = [];
    inputs[me.id] = input;
    step(w, inputs);
    const kick = w.events.find((e) => (e.type === 'shot' || e.type === 'powerShot' || e.type === 'pass') && e.player === me.id);
    if (!kick || w.ball.owner !== -1) return null;

    // From here on only the ball moves; freeze the rest so nothing else changes in the copy.
    w.phase = 'goal';
    this.active = true;
    this.kicker = me.id;
    this.age = 0;
    return kick.type as 'shot' | 'powerShot' | 'pass';
  }

  /** Advance the predicted ball by one tick. Gives up after a while in case the server never agrees. */
  tick(): void {
    if (!this.active) return;
    flyLooseBall(this.scratch);
    if (++this.age > MAX_KICK_PREDICTION_TICKS) this.active = false;
  }

  /** The server says someone else touched the ball (or it was a goal or save): use its version again. */
  stop(): void {
    this.active = false;
  }
}

/** Show our own predicted kick for at most this long (1.2 s) before trusting only the server. */
const MAX_KICK_PREDICTION_TICKS = 72;
