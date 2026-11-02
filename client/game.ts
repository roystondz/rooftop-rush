// Runs a local match: reads input, asks bots for theirs, and steps the shared simulation
// at a fixed 60 ticks per second.
import { Bot, BOT_SKILLS, type Difficulty } from '../shared/bot';
import { DT } from '../shared/constants';
import {
  assignStartingPlayers,
  autoSwitch,
  autoSwitchDefending,
  humanPlayers,
  pressToward,
  screenToPitch,
  switchTarget,
  switchToNearest,
  SwitchTimer,
  type Handover,
  type Human,
} from '../shared/control';
import { createWorld, step } from '../shared/sim';
import type { GameMode, Input, Team, World } from '../shared/types';
import type { Effects } from './effects';
import type { Hud } from './hud';
import type { InputManager } from './input';
import { Renderer, takeSnapshot, type Snapshot } from './renderer';
import { Replay } from './replay';

export class Game {
  world: World | null = null;
  readonly humanTeam: Team = 0;
  paused = false;

  /** Just you, in seat 0. (Online, the server keeps one of these per person.) */
  private me: Human = { seat: 0, team: 0, player: -1 };
  private switchTimer = new SwitchTimer();
  private bots: Bot[] = [];
  private prev: Snapshot | null = null;
  private acc = 0;
  private replay = new Replay();

  constructor(
    private renderer: Renderer,
    private hud: Hud,
    private input: InputManager,
    private effects: Effects,
  ) {
    this.replay.onGoalMoment = (w) => this.effects.replayGoal(w);
  }

  get controlledId(): number {
    return this.me.player;
  }

  start(difficulty: Difficulty, mode: GameMode = 'match'): void {
    const w = createWorld({ mode });
    const skill = BOT_SKILLS[difficulty];
    for (const p of w.players) if (p.team !== this.humanTeam) p.speedScale = skill.speedScale;
    // Your teammates always play at normal level; the difficulty only changes the opponents.
    // A fresh seed each match, so bots don't make the same choices (e.g. penalty sides) every game.
    const seed = Math.floor(Math.random() * 1e9);
    this.bots = w.players.map((p) => new Bot(p.id, p.team === this.humanTeam ? BOT_SKILLS.normal : skill, seed));
    this.world = w;
    this.me = { seat: 0, team: this.humanTeam, player: -1 };
    assignStartingPlayers(w, [this.me]);
    this.prev = null;
    this.acc = 0;
    this.paused = false;
    this.switchTimer = new SwitchTimer();
    this.replay.reset();
    this.renderer.setReplay(null);
    this.effects.reset(this.humanTeam);
    this.renderer.setupPlayers(w);
    this.hud.show();
  }

  stop(): void {
    this.world = null;
    this.hud.hide();
    this.renderer.setReplay(null);
  }

  /** Called every animation frame by main.ts. */
  frame(frameDt: number): void {
    const w = this.world;
    if (!w) return;
    if (!this.paused) {
      this.acc += frameDt;
      while (this.acc >= DT) {
        this.tick(w);
        this.acc -= DT;
      }
    }
    const replayed = this.paused ? null : this.replay.update(frameDt);
    this.renderer.setReplay(replayed ? this.replay.goalSide : null);
    this.hud.showReplay(!!replayed);
    if (replayed) {
      this.renderer.setSwitchHint(-1);
      this.renderer.render(replayed, null, 1, frameDt, -1);
      this.hud.update(w, w.players[this.controlledId], frameDt);
      return;
    }
    const alpha = this.paused ? 1 : this.acc / DT;
    const owner = w.ball.owner >= 0 ? w.players[w.ball.owner] : undefined;
    const defending = w.phase === 'playing' && owner?.team !== this.humanTeam;
    this.renderer.setSwitchHint(defending ? switchTarget(w, [this.me], this.me) : -1);
    this.renderer.render(w, this.prev, alpha, this.paused ? 0 : frameDt, this.controlledId);
    this.hud.update(w, w.players[this.controlledId], frameDt);
  }

  private tick(w: World): void {
    const human = this.input.read();
    Object.assign(human.game, screenToPitch(human.game, w)); // controls follow the penalty camera
    // Any action button skips a replay, and locally that also cuts the wait for the kickoff.
    const g = human.game;
    const wasReplaying = this.replay.playing;
    this.replay.press(g.shoot || g.pass || g.tackle || !!g.through || human.switchPlayer);
    if (wasReplaying && !this.replay.playing && w.phase === 'goal') w.phaseTimer = Math.min(w.phaseTimer, 0.3);
    if (human.switchPlayer) this.handOver(switchToNearest(w, [this.me], this.me, this.switchTimer));

    const me = w.players[this.controlledId];
    if (human.press && me && Math.hypot(human.game.moveX, human.game.moveZ) < 0.2) {
      Object.assign(human.game, pressToward(me, w.ball)); // hold press: chase the ball
    }

    const humans = humanPlayers([this.me]);
    const inputs: Input[] = w.players.map((p) =>
      p.id === this.controlledId ? human.game : this.bots[p.id].think(w, humans),
    );
    this.prev = takeSnapshot(w, this.prev ?? undefined);
    step(w, inputs);
    this.replay.record(w, w.tick * DT);
    if (w.mode === 'match' && w.events.some((e) => e.type === 'goal')) this.replay.goal(w.tick * DT);

    for (const c of autoSwitch(w, [this.me], w.events, this.switchTimer)) this.handOver(c);
    this.handOver(autoSwitchDefending(w, [this.me], this.me, this.switchTimer));
    this.effects.watchPhase(w);
    for (const e of w.events) this.effects.handle(w, e);
  }

  private handOver(change: Handover | null): void {
    if (!change) return;
    this.bots[change.from]?.reset();
    this.bots[change.to]?.reset();
  }
}
