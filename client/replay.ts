// Instant replay: remembers the last few seconds of what was on screen and, a moment after a goal,
// plays the build-up back with the last second in slow motion. Used by local and online play.
import { REPLAY } from '../shared/constants';
import { lerp } from '../shared/math';
import type { World } from '../shared/types';

interface Frame {
  t: number; // seconds, on the match's own clock
  w: World;
}

/** Enough history for the build-up, plus the time between the goal and the replay starting. */
const KEEP = REPLAY.before + REPLAY.delay + REPLAY.after + 1;

export class Replay {
  /** Called once as the replayed ball goes in, so the net can bulge again. */
  onGoalMoment: (w: World) => void = () => {};
  private frames: Frame[] = [];
  private goalAt = -1;
  private startIn = 0;
  /** Replay time being shown; -1 when no replay is playing. */
  private clock = -1;
  private crossed = false;
  private wasDown = true;
  private view: World | null = null;

  get playing(): boolean {
    return this.clock >= 0;
  }

  /** Which end the replayed goal went in: +1 or -1 (for the replay camera). */
  get goalSide(): 1 | -1 {
    const last = this.frames.find((f) => f.t >= this.goalAt) ?? this.frames[this.frames.length - 1];
    return last && last.w.ball.x < 0 ? -1 : 1;
  }

  reset(): void {
    this.frames = [];
    this.goalAt = -1;
    this.clock = -1;
  }

  /** Call once per tick (local) or per drawn frame (online), with the match time it shows. */
  record(w: World, t: number): void {
    if (w.mode !== 'match') return;
    const last = this.frames[this.frames.length - 1];
    if (last && t <= last.t) {
      if (t < last.t - 1) this.frames = []; // the clock jumped back: a new match
      else return;
    }
    this.frames.push({ t, w: copyWorld(w) });
    while (this.frames.length > 0 && this.frames[0].t < t - KEEP) this.frames.shift();
  }

  /** A goal went in at match time `t`: the replay starts after a short live celebration. */
  goal(t: number): void {
    this.goalAt = t;
    this.startIn = REPLAY.delay;
    this.clock = -1;
  }

  /** Any action button skips the replay (it has to be a fresh press, not one still held). */
  press(down: boolean): void {
    if (down && !this.wasDown && this.playing) this.stop();
    this.wasDown = down;
  }

  stop(): void {
    this.clock = -1;
    this.goalAt = -1;
  }

  /** Moves the replay on; returns the world to draw instead of the live one, or null for live. */
  update(dt: number): World | null {
    if (this.goalAt < 0) return null;
    if (this.clock < 0) {
      this.startIn -= dt;
      if (this.startIn > 0 || this.frames.length < 2) return null;
      // Start a few seconds back, but never before the kickoff, when everyone jumped into place.
      let start = Math.max(this.frames[0].t, this.goalAt - REPLAY.before);
      for (const f of this.frames) if (f.t < this.goalAt && f.w.phase === 'kickoff') start = Math.max(start, f.t);
      this.clock = start;
      this.crossed = false;
    }
    const slow = this.clock > this.goalAt - REPLAY.slowFrom;
    this.clock += dt * (slow ? REPLAY.slowSpeed : 1);
    if (this.clock >= this.goalAt + REPLAY.after || this.clock > this.frames[this.frames.length - 1].t) {
      this.stop();
      return null;
    }
    const w = this.frameAt(this.clock);
    if (!this.crossed && this.clock >= this.goalAt) {
      this.crossed = true;
      this.onGoalMoment(w);
    }
    return w;
  }

  /** The recorded world at time `t`, blended between the two nearest frames so slow motion is smooth. */
  private frameAt(t: number): World {
    const fs = this.frames;
    let i = 1;
    while (i < fs.length - 1 && fs[i].t < t) i++;
    const a = fs[i - 1];
    const b = fs[i];
    const k = b.t === a.t ? 1 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)));
    const v = (this.view ??= copyWorld(b.w));
    Object.assign(v, b.w, { players: v.players, ball: v.ball });
    if (v.players.length !== b.w.players.length) v.players = b.w.players.map((p) => ({ ...p }));
    b.w.players.forEach((pb, n) => {
      const pa = a.w.players[n] ?? pb;
      Object.assign(v.players[n], pb, {
        x: lerp(pa.x, pb.x, k),
        z: lerp(pa.z, pb.z, k),
        facing: lerpAngle(pa.facing, pb.facing, k),
      });
    });
    Object.assign(v.ball, b.w.ball, {
      x: lerp(a.w.ball.x, b.w.ball.x, k),
      y: lerp(a.w.ball.y, b.w.ball.y, k),
      z: lerp(a.w.ball.z, b.w.ball.z, k),
    });
    // Drawn as if play were still going, so nobody celebrates before the ball goes in.
    v.phase = t < this.goalAt ? 'playing' : b.w.phase;
    return v;
  }
}

function copyWorld(w: World): World {
  return { ...w, players: w.players.map((p) => ({ ...p })), ball: { ...w.ball }, events: [] };
}

function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}
