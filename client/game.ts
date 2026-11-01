// Runs a local match: reads input, asks bots for theirs, and steps the shared simulation
// at a fixed 60 ticks per second.
import { Bot, BOT_SKILLS, type Difficulty } from '../shared/bot';
import { DT } from '../shared/constants';
import {
  autoSwitch,
  autoSwitchDefending,
  switchTarget,
  switchToNearest,
  SwitchTimer,
  type Controlled,
  type Handover,
} from '../shared/control';
import { createWorld, step } from '../shared/sim';
import type { Input, Team, World } from '../shared/types';
import type { Effects } from './effects';
import type { Hud } from './hud';
import type { InputManager } from './input';
import { Renderer, takeSnapshot, type Snapshot } from './renderer';

export class Game {
  world: World | null = null;
  readonly humanTeam: Team = 0;
  paused = false;

  private controlled: Controlled = [-1, -1];
  private switchTimer = new SwitchTimer();
  private bots: Bot[] = [];
  private prev: Snapshot | null = null;
  private acc = 0;

  constructor(
    private renderer: Renderer,
    private hud: Hud,
    private input: InputManager,
    private effects: Effects,
  ) {}

  get controlledId(): number {
    return this.controlled[this.humanTeam];
  }

  start(difficulty: Difficulty): void {
    const w = createWorld();
    const skill = BOT_SKILLS[difficulty];
    for (const p of w.players) if (p.team !== this.humanTeam) p.speedScale = skill.speedScale;
    // Your teammates always play at normal level; the difficulty only changes the opponents.
    this.bots = w.players.map((p) => new Bot(p.id, p.team === this.humanTeam ? BOT_SKILLS.normal : skill));
    this.world = w;
    this.controlled = [-1, -1];
    this.controlled[this.humanTeam] = w.players.find((p) => p.team === this.humanTeam && p.role === 'attacker')!.id;
    this.prev = null;
    this.acc = 0;
    this.paused = false;
    this.switchTimer = new SwitchTimer();
    this.effects.reset(this.humanTeam);
    this.renderer.setupPlayers(w);
    this.hud.show();
  }

  stop(): void {
    this.world = null;
    this.hud.hide();
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
    const alpha = this.paused ? 1 : this.acc / DT;
    const owner = w.ball.owner >= 0 ? w.players[w.ball.owner] : undefined;
    const defending = w.phase === 'playing' && owner?.team !== this.humanTeam;
    this.renderer.setSwitchHint(defending ? switchTarget(w, this.controlled, this.humanTeam) : -1);
    this.renderer.render(w, this.prev, alpha, this.paused ? 0 : frameDt, this.controlledId);
    this.hud.update(w, w.players[this.controlledId], frameDt);
  }

  private tick(w: World): void {
    const human = this.input.read();
    if (human.switchPlayer) this.handOver(switchToNearest(w, this.controlled, this.humanTeam, this.switchTimer));

    const humans = new Set([this.controlledId]);
    const inputs: Input[] = w.players.map((p) =>
      p.id === this.controlledId ? human.game : this.bots[p.id].think(w, humans),
    );
    this.prev = takeSnapshot(w, this.prev ?? undefined);
    step(w, inputs);

    for (const c of autoSwitch(w, this.controlled, w.events, this.switchTimer)) this.handOver(c);
    this.handOver(autoSwitchDefending(w, this.controlled, this.humanTeam, this.switchTimer));
    this.effects.watchPhase(w);
    for (const e of w.events) this.effects.handle(w, e);
  }

  private handOver(change: Handover | null): void {
    if (!change) return;
    this.bots[change.from]?.reset();
    this.bots[change.to]?.reset();
  }
}
