// Online match: this browser sends its inputs 60 times a second and draws what the server says.
// Other players and the ball are drawn slightly in the past (INTERP_DELAY_TICKS) so motion can
// be blended smoothly between the server's snapshots, which arrive 30 times a second.
// Your own player is drawn in the present, using client prediction (shared/prediction.ts).
import { DT } from '../shared/constants';
import { InterpolationClock } from '../shared/interp';
import { KickPredictor, Predictor } from '../shared/prediction';
import {
  applySnapshot,
  lerpSnapshots,
  packInput,
  unpackInput,
  type LobbyInfo,
  type ServerMessage,
  type Snapshot,
} from '../shared/protocol';
import { humansFromSeats, pressToward, screenToPitch, switchTarget, type Human } from '../shared/control';
import { carriedBallPosition, createWorld } from '../shared/sim';
import { NO_INPUT } from '../shared/types';
import type { Input, MatchEventType, Team, World } from '../shared/types';
import type { Effects } from './effects';
import type { Hud } from './hud';
import type { InputManager } from './input';
import type { Connection } from './net';
import type { Renderer } from './renderer';
import { Replay } from './replay';

const PING_EVERY = 2;
/** Events meaning someone else touched the ball, so our predicted kick should give way to the server. */
const BALL_TOUCHED: readonly MatchEventType[] = ['possession', 'save', 'tackle', 'goal', 'bounce'];
/** How quickly the ball glides from our predicted spot to the server's after a hand-over. */
const BALL_SMOOTHING = 10;

export interface OnlineCallbacks {
  /** The room changed: who's in, which team, whether it has started. */
  lobby(info: LobbyInfo): void;
  start(team: Team, names: [string, string]): void;
  /** A short message to show, e.g. someone joined or left. */
  notice(text: string): void;
  error(message: string): void;
  disconnected(): void;
}

export class OnlineGame {
  team: Team = 0;
  /** Our seat in the room (each person has one). */
  seat = -1;
  lobbyInfo: LobbyInfo | null = null;
  started = false;
  ping = 0;

  private view: World = createWorld(); // what we draw (blended)
  private latest: World = createWorld(); // newest snapshot, used for sounds and messages
  private snaps: Snapshot[] = [];
  private clock = new InterpolationClock();
  private seq = 0;
  private acc = 0;
  private pingTimer = 0;
  private predictor = new Predictor();
  private kick = new KickPredictor();
  private lastInput: Input = { ...NO_INPUT };
  /** Our kick's sound already played locally, so skip the server's copy of that event. */
  private kickSoundPlayed = false;
  private ballOffset = { x: 0, y: 0, z: 0 };
  private handOverBall = false;
  private replay = new Replay();

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
    this.replay.onGoalMoment = (w) => this.effects.replayGoal(w);
    conn.onMessage = (m) => this.receive(m);
    conn.onClose = () => {
      this.started = false;
      this.on.disconnected();
    };
  }

  /** The newest state from the server (for deciding things like the touch button layout). */
  get world(): World {
    return this.latest;
  }

  get controlledId(): number {
    const s = this.snaps[this.snaps.length - 1];
    return s ? (s.controlled[this.seat] ?? -1) : -1;
  }

  leave(): void {
    this.conn.onClose = () => {};
    this.conn.send({ t: 'leave' });
    this.conn.close();
    this.started = false;
    this.hud.hide();
    this.renderer.setReplay(null);
  }

  /** Lobby: move to the other team. */
  chooseTeam(team: Team): void {
    this.conn.send({ t: 'team', team });
  }

  /** Lobby: the host starts the match. */
  requestStart(): void {
    this.conn.send({ t: 'start' });
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
      Object.assign(fi.game, screenToPitch(fi.game, this.latest)); // controls follow the penalty camera
      // Any action button skips the replay (just on this screen; the server keeps its own pause).
      this.replay.press(fi.game.shoot || fi.game.pass || fi.game.tackle || !!fi.game.through || fi.switchPlayer);
      if (fi.switchPlayer) this.conn.send({ t: 'switch' });
      if (fi.press && Math.hypot(fi.game.moveX, fi.game.moveZ) < 0.2) {
        // Hold press: chase the ball from where we predict we are right now.
        const me = { x: this.predictor.visualX, z: this.predictor.visualZ };
        Object.assign(fi.game, pressToward(me, this.latest.ball));
      }
      const packed = packInput(fi.game);
      const sent = unpackInput(packed); // predict with exactly what we send, rounding included
      this.predictKick(sent);
      this.conn.send({ t: 'input', seq: ++this.seq, i: packed });
      this.predictor.addInput(this.seq, sent);
      this.lastInput = sent;
      const wasActive = this.kick.active;
      this.kick.tick();
      if (wasActive && !this.kick.active) {
        this.handOverBall = true; // prediction timed out
        this.kickSoundPlayed = false;
      }
    }

    if (this.snaps.length === 0) return;
    this.clock.advance(frameDt, this.snaps[this.snaps.length - 1].tick);
    this.blendInto(this.view);
    this.predictor.decay(frameDt);
    this.drawPrediction(this.view);
    this.drawBall(this.view, frameDt);
    this.replay.record(this.view, this.clock.renderTick * DT);
    const replayed = this.replay.update(frameDt);
    this.renderer.setReplay(replayed ? this.replay.goalSide : null);
    this.hud.showReplay(!!replayed);
    if (replayed) {
      this.renderer.setSwitchHint(-1);
      this.renderer.setOtherHumans([]);
      this.renderer.render(replayed, null, 1, frameDt, -1);
      this.hud.update(this.view, this.view.players[this.controlledId], frameDt);
      this.updateNetReadout();
      return;
    }
    const humans = humansFromSeats(this.view, this.snaps[this.snaps.length - 1].controlled);
    this.renderer.setSwitchHint(defendingHint(this.view, humans, this.seat));
    // Rings under the players other people are controlling (teammates and opponents).
    this.renderer.setOtherHumans(humans.filter((h) => h.seat !== this.seat).map((h) => h.player));
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

  /** If this input kicks the ball, show the kick now instead of after a round trip. */
  private predictKick(input: Input): void {
    const latest = this.snaps[this.snaps.length - 1];
    const me = this.predictor.state;
    if (!latest || this.kick.active || this.predictor.playerId !== this.controlledId) return;
    const kind = this.kick.tryKick(latest, me, input, this.lastInput);
    if (!kind) return;
    // Play the kick sound now; the server's matching event will be skipped.
    this.effects.handle(this.latest, { type: kind, player: me.id, team: this.team, strength: me.charge / 0.9 });
    this.kickSoundPlayed = true;
    this.ballOffset = { x: 0, y: 0, z: 0 };
  }

  /** Draws the predicted ball after our own kick, then glides it back to the server's ball. */
  private drawBall(w: World, frameDt: number): void {
    const b = w.ball;
    if (this.kick.active) {
      Object.assign(b, this.kick.ball, { owner: -1, power: this.kick.power });
      return;
    }
    if (this.handOverBall) {
      // Start from where the predicted ball was drawn, and fade the difference out.
      const p = this.kick.ball;
      this.ballOffset = { x: p.x - b.x, y: p.y - b.y, z: p.z - b.z };
      if (Math.hypot(this.ballOffset.x, this.ballOffset.z) > 12) this.ballOffset = { x: 0, y: 0, z: 0 };
      this.handOverBall = false;
    }
    const k = Math.exp(-BALL_SMOOTHING * frameDt);
    this.ballOffset.x *= k;
    this.ballOffset.y *= k;
    this.ballOffset.z *= k;
    b.x += this.ballOffset.x;
    b.y = Math.max(b.y + this.ballOffset.y, 0.3);
    b.z += this.ballOffset.z;
  }

  private updateNetReadout(): void {
    let text = `${this.ping} ms`;
    if (this.conn.lag.lagMs || this.conn.lag.jitterMs) text += ' (simulated)';
    if (this.debug) {
      const p = this.predictor;
      text += ` · buffer ${Math.round(this.clock.delayTicks * DT * 1000)} ms · ${p.pendingCount} unconfirmed · fix ${p.lastCorrection.toFixed(2)} m`;
    }
    this.hud.setNet(text);
  }

  private blendInto(w: World): void {
    const snaps = this.snaps;
    // Find the two snapshots either side of the render time.
    let i = snaps.length - 1;
    const renderTick = this.clock.renderTick;
    while (i > 0 && snaps[i - 1].tick > renderTick) i--;
    const b = snaps[i];
    const a = i > 0 ? snaps[i - 1] : b;
    const t = b.tick === a.tick ? 1 : Math.min(1, Math.max(0, (renderTick - a.tick) / (b.tick - a.tick)));
    lerpSnapshots(w, a, b, t);
    // Drop snapshots we will never need again.
    if (i > 2) snaps.splice(0, i - 2);
  }

  private receive(m: ServerMessage): void {
    switch (m.t) {
      case 'lobby': {
        this.lobbyInfo = m;
        this.seat = m.you;
        const mine = m.players.find((p) => p.seat === m.you);
        if (mine && !m.started) this.team = mine.team;
        if (!m.started && this.started) {
          // Full time is over and the room is back in the lobby.
          this.started = false;
          this.hud.hide();
          this.renderer.setOtherHumans([]);
        }
        this.on.lobby(m);
        break;
      }
      case 'start':
        this.team = m.team;
        this.seat = m.you;
        this.snaps = [];
        this.view = createWorld({ mode: m.mode });
        this.latest = createWorld({ mode: m.mode });
        this.clock = new InterpolationClock();
        this.predictor = new Predictor();
        this.kick = new KickPredictor();
        this.lastInput = { ...NO_INPUT };
        this.kickSoundPlayed = false;
        this.ballOffset = { x: 0, y: 0, z: 0 };
        this.replay.reset();
        this.renderer.setReplay(null);
        this.started = true;
        this.effects.reset(m.team);
        this.renderer.setupPlayers(this.view);
        this.hud.show(m.team);
        this.on.start(m.team, m.names);
        break;
      case 'snap':
        this.snaps.push(m.s);
        if (this.snaps.length > 120) this.snaps.shift();
        this.clock.onSnapshot(m.s.tick, performance.now());
        applySnapshot(this.latest, m.s);
        this.predictor.reconcile(m.s, m.ack, m.s.controlled[this.seat] ?? -1);
        this.effects.watchPhase(this.latest);
        for (const e of m.s.ev) {
          const ourKick = (e.type === 'shot' || e.type === 'powerShot' || e.type === 'pass') && e.player === this.kick.kicker;
          if (ourKick && this.kickSoundPlayed) {
            this.kickSoundPlayed = false; // already heard it when we predicted the kick
            continue;
          }
          // A bounce off the ground has no player; only a touch by someone else ends our prediction.
          const touchedByOther = BALL_TOUCHED.includes(e.type) && e.player !== undefined && e.player !== this.kick.kicker;
          if (this.kick.active && touchedByOther) {
            this.kick.stop();
            this.handOverBall = true;
          }
          if (e.type === 'goal' && this.latest.mode === 'match') this.replay.goal(m.s.tick * DT);
          this.effects.handle(this.latest, e);
        }
        break;
      case 'notice':
        this.on.notice(m.text);
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
function defendingHint(w: World, humans: Human[], seat: number): number {
  const me = humans.find((h) => h.seat === seat);
  const owner = w.ball.owner >= 0 ? w.players[w.ball.owner] : undefined;
  if (!me || w.phase !== 'playing' || owner?.team === me.team) return -1;
  return switchTarget(w, humans, me);
}
