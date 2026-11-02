// Runs a training drill: ten attempts, one after another, on the same fixed 60 ticks per second
// as a match. training.ts sets up and judges each attempt; this file plays them and draws them.
import { Bot, BOT_SKILLS } from '../shared/bot';
import { DT } from '../shared/constants';
import { step } from '../shared/sim';
import { NO_INPUT, type Input, type World } from '../shared/types';
import type { Effects } from './effects';
import type { Hud } from './hud';
import type { InputManager } from './input';
import { Renderer, takeSnapshot, type Snapshot } from './renderer';
import { ATTEMPTS, DRILL_INFO, holdSpot, judge, runnerInput, setupAttempt, type Attempt, type Drill } from './training';

/** Seconds between one attempt ending and the next ball. */
const BETWEEN = 1.4;

export interface TrainingResult {
  drill: Drill;
  hits: number;
  /** Power drill: fastest shot, km/h. */
  fastest: number;
}

export class TrainingGame {
  world: World | null = null;
  paused = false;
  drill: Drill = 'curl';
  onFinish: (r: TrainingResult) => void = () => {};

  private attempt: Attempt | null = null;
  private n = 0;
  private hits = 0;
  private fastest = 0;
  private seed = 0;
  private keeper: Bot | null = null;
  private between = 0;
  private prev: Snapshot | null = null;
  private acc = 0;

  constructor(
    private renderer: Renderer,
    private hud: Hud,
    private input: InputManager,
    private effects: Effects,
  ) {}

  get controlledId(): number {
    return this.attempt?.you ?? -1;
  }

  start(drill: Drill): void {
    this.drill = drill;
    this.seed = Math.floor(Math.random() * 1e9);
    this.n = 0;
    this.hits = 0;
    this.fastest = 0;
    this.paused = false;
    this.effects.reset(0);
    this.nextAttempt();
    this.renderer.setupPlayers(this.world!); // once per drill: every attempt uses the same six players
    this.renderer.setCloseCamera(true);
    this.hud.show();
    this.hud.setTraining(this.barText());
  }

  stop(): void {
    this.world = null;
    this.attempt = null;
    this.renderer.setTargets([]);
    this.renderer.setCloseCamera(false);
    this.hud.setTraining(null);
    this.hud.hide();
  }

  frame(frameDt: number): void {
    const w = this.world;
    if (!w) return;
    if (!this.paused) {
      this.acc += frameDt;
      while (this.acc >= DT && this.world) {
        this.tick(this.world);
        this.acc -= DT;
      }
    }
    if (!this.world) return;
    const alpha = this.paused ? 1 : this.acc / DT;
    this.renderer.setSwitchHint(-1);
    this.renderer.render(this.world, this.prev, alpha, this.paused ? 0 : frameDt, this.controlledId);
    this.hud.update(this.world, this.world.players[this.controlledId], frameDt);
  }

  private nextAttempt(): void {
    const { world, attempt } = setupAttempt(this.drill, this.n, this.seed);
    this.world = world;
    this.attempt = attempt;
    this.keeper = attempt.keeper >= 0 ? new Bot(attempt.keeper, BOT_SKILLS.hard, this.seed + this.n) : null;
    this.prev = null;
    this.renderer.setTargets(attempt.targets);
    this.hud.setTraining(this.barText());
  }

  private tick(w: World): void {
    const a = this.attempt!;
    const human = this.input.read();
    const inputs: Input[] = w.players.map(() => NO_INPUT);
    inputs[a.you] = human.game;
    if (a.runner >= 0) inputs[a.runner] = { ...NO_INPUT, ...runnerInput(w, a) };
    if (this.keeper) inputs[a.keeper] = this.keeper.think(w, new Set([a.you]));
    w.rush = [0, 0]; // no Rush power shots in training: it's your own power that counts

    this.prev = takeSnapshot(w, this.prev ?? undefined);
    step(w, inputs);
    holdSpot(w, a);
    // Sounds for kicks, bounces and saves; goals are judged by the drill, not announced as match goals.
    for (const e of w.events) if (e.type !== 'goal') this.effects.handle(w, e);

    if (this.between > 0) {
      this.between -= DT;
      if (this.between <= 0) this.advance();
      return;
    }
    const outcome = judge(w, a, w.events);
    if (!outcome.done) return;
    if (outcome.success) {
      this.hits++;
      this.effects.cheer(w);
    }
    if (this.drill === 'power') this.fastest = Math.max(this.fastest, Math.round(a.speed * 3.6));
    this.hud.message(outcome.message, outcome.detail ?? `${this.hits} of ${this.n + 1}`, BETWEEN);
    this.between = BETWEEN;
  }

  private advance(): void {
    this.n++;
    if (this.n >= ATTEMPTS) {
      const result = { drill: this.drill, hits: this.hits, fastest: this.fastest };
      this.stop();
      this.onFinish(result);
      return;
    }
    this.nextAttempt();
  }

  private barText(): string {
    const info = DRILL_INFO[this.drill];
    return `${info.title.toUpperCase()} · ball ${Math.min(this.n + 1, ATTEMPTS)} of ${ATTEMPTS} · ${this.hits} ✓`;
  }
}
