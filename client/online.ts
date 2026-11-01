// Online match: this browser sends its inputs 60 times a second and draws what the server says.
// Other players and the ball are drawn slightly in the past (INTERP_DELAY_TICKS) so motion can
// be blended smoothly between the server's snapshots, which arrive 30 times a second.
// Your own player is drawn in the present, using client prediction (shared/prediction.ts).
import { DT, TICK_RATE } from '../shared/constants';
import { Predictor } from '../shared/prediction';
import {
  applySnapshot,
  lerpSnapshots,
  packInput,
  unpackInput,
  type ServerMessage,
  type Snapshot,
} from '../shared/protocol';
import { switchTarget } from '../shared/control';
import { carriedBallPosition, createWorld } from '../shared/sim';
import type { Team, World } from '../shared/types';
import type { Effects } from './effects';
import type { Hud } from './hud';
import type { InputManager } from './input';
import type { Connection } from './net';
import type { Renderer } from './renderer';

/** 6 ticks = 100 ms. Big enough to always have two snapshots to blend, small enough to feel live. */
const INTERP_DELAY_TICKS = 6;
const PING_EVERY = 2;

export interface OnlineCallbacks {
  room(code: string, isPublic: boolean): void;
  start(team: Team, names: [string, string]): void;
  rematchRequested(team: Team): void;
  opponentLeft(): void;
  error(message: string): void;
  disconnected(): void;
}

export class OnlineGame {
  team: Team = 0;
  started = false;
  ping = 0;

  private view: World = createWorld(); // what we draw (blended)
  private latest: World = createWorld(); // newest snapshot, used for sounds and messages
  private snaps: Snapshot[] = [];
  private renderTick = 0;
  private seq = 0;
  private acc = 0;
  private pingTimer = 0;
  private predictor = new Predictor();

  /** `debug` shows a ghost where the server last saw your player, plus prediction numbers. */
  constructor(
    private conn: Connection,
    private renderer: Renderer,
    private hud: Hud,
    private input: InputManager,
    private effects: Effects,
    private debug: boolean,
    private on: OnlineCallbacks,
  ) {
    conn.onMessage = (m) => this.receive(m);
    conn.onClose = () => {
      this.started = false;
      this.on.disconnected();
    };
  }

  get controlledId(): number {
    const s = this.snaps[this.snaps.length - 1];
    return s ? s.controlled[this.team] : -1;
  }

  leave(): void {
    this.conn.onClose = () => {};
    this.conn.send({ t: 'leave' });
    this.conn.close();
    this.started = false;
    this.hud.hide();
  }

  rematch(): void {
    this.conn.send({ t: 'rematch' });
  }

  /** Called every animation frame by main.ts. */
  frame(frameDt: number): void {
    this.pingTimer -= frameDt;
    if (this.pingTimer <= 0) {
      this.pingTimer = PING_EVERY;
      this.conn.send({ t: 'ping', at: performance.now() });
    }
    if (!this.started) return;

    // Send our input at the simulation's own rate: one per tick.
    this.acc = Math.min(this.acc + frameDt, DT * 5);
    while (this.acc >= DT) {
      this.acc -= DT;
      const fi = this.input.read();
      if (fi.switchPlayer) this.conn.send({ t: 'switch' });
      const packed = packInput(fi.game);
      this.conn.send({ t: 'input', seq: ++this.seq, i: packed });
      // Predict with exactly what we sent, rounding included, so we match the server.
      this.predictor.addInput(this.seq, unpackInput(packed));
    }

    if (this.snaps.length === 0) return;
    this.advanceRenderClock(frameDt);
    this.blendInto(this.view);
    this.predictor.decay(frameDt);
    this.drawPrediction(this.view);
    this.renderer.setSwitchHint(defendingHint(this.view, this.snaps[this.snaps.length - 1].controlled, this.team));
    this.renderer.render(this.view, null, 1, frameDt, this.controlledId);
    this.hud.update(this.view, this.view.players[this.controlledId], frameDt);
    this.updateNetReadout();
  }

  /** Puts your own player (and the ball, if you're dribbling) at the predicted, present-time spot. */
  private drawPrediction(w: World): void {
    const pred = this.predictor;
    const me = w.players[pred.playerId];
    if (!me || pred.playerId !== this.controlledId) return;
    const s = pred.state;
    Object.assign(me, {
      x: pred.visualX,
      z: pred.visualZ,
      vx: s.vx,
      vz: s.vz,
      facing: s.facing,
      stamina: s.stamina,
      sprinting: s.sprinting,
      charging: s.charging,
      charge: s.charge,
    });
    if (w.ball.owner === me.id) Object.assign(w.ball, carriedBallPosition(me));

    if (this.debug) {
      const server = this.latest.players[pred.playerId];
      this.renderer.setGhost(server ? { x: server.x, z: server.z } : null);
    }
  }

  private updateNetReadout(): void {
    let text = `${this.ping} ms`;
    if (this.conn.lag.lagMs || this.conn.lag.jitterMs) text += ' (simulated)';
    if (this.debug) {
      const p = this.predictor;
      text += ` · ${p.pendingCount} unconfirmed · fix ${p.lastCorrection.toFixed(2)} m`;
    }
    this.hud.setNet(text);
  }

  private advanceRenderClock(frameDt: number): void {
    const newest = this.snaps[this.snaps.length - 1].tick;
    const target = newest - INTERP_DELAY_TICKS;
    this.renderTick += frameDt * TICK_RATE;
    const drift = target - this.renderTick;
    // Far off (first snapshot, or a long stall): jump. Slightly off: ease back gently.
    if (Math.abs(drift) > 15) this.renderTick = target;
    else this.renderTick += drift * 0.05;
  }

  private blendInto(w: World): void {
    const snaps = this.snaps;
    // Find the two snapshots either side of the render time.
    let i = snaps.length - 1;
    while (i > 0 && snaps[i - 1].tick > this.renderTick) i--;
    const b = snaps[i];
    const a = i > 0 ? snaps[i - 1] : b;
    const t = b.tick === a.tick ? 1 : Math.min(1, Math.max(0, (this.renderTick - a.tick) / (b.tick - a.tick)));
    lerpSnapshots(w, a, b, t);
    // Drop snapshots we will never need again.
    if (i > 2) snaps.splice(0, i - 2);
  }

  private receive(m: ServerMessage): void {
    switch (m.t) {
      case 'room':
        this.team = m.team;
        this.on.room(m.code, m.isPublic);
        break;
      case 'start':
        this.team = m.team;
        this.snaps = [];
        this.view = createWorld();
        this.latest = createWorld();
        this.renderTick = 0;
        this.predictor = new Predictor();
        this.started = true;
        this.effects.reset(m.team);
        this.renderer.setupPlayers(this.view);
        this.hud.show(m.team);
        this.on.start(m.team, m.names);
        break;
      case 'snap':
        this.snaps.push(m.s);
        if (this.snaps.length > 60) this.snaps.shift();
        applySnapshot(this.latest, m.s);
        this.predictor.reconcile(m.s, m.ack, m.s.controlled[this.team]);
        this.effects.watchPhase(this.latest);
        for (const e of m.s.ev) this.effects.handle(this.latest, e);
        break;
      case 'rematch':
        this.on.rematchRequested(m.team);
        break;
      case 'left':
        this.started = false;
        this.on.opponentLeft();
        break;
      case 'error':
        this.on.error(m.message);
        break;
      case 'pong':
        this.ping = Math.round(performance.now() - m.at);
        break;
    }
  }
}

/** While the other team has the ball, mark the teammate the switch button would give you. */
function defendingHint(w: World, controlled: [number, number], team: Team): number {
  const owner = w.ball.owner >= 0 ? w.players[w.ball.owner] : undefined;
  if (w.phase !== 'playing' || owner?.team === team) return -1;
  return switchTarget(w, [...controlled], team);
}
