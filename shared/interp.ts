// Decides how far in the past to draw other players and the ball online.
//
// Snapshots never arrive perfectly evenly. Drawing a little in the past means there is always a
// newer snapshot to blend toward. The steadier the connection, the smaller that buffer can be,
// so the delay is measured and adjusted as you play instead of being a fixed 100 ms.
import { DT, TICK_RATE } from './constants';
import { clamp } from './math';

/** Never draw closer than this to the newest snapshot (ticks). */
export const MIN_DELAY_TICKS = 2.5;
/** Never draw further back than this, however bad the connection (ticks). */
export const MAX_DELAY_TICKS = 9;
/** How many "typical wobbles" of arrival time the buffer covers. */
const JITTER_MARGIN = 2.5;

export class InterpolationClock {
  /** The (fractional) server tick being drawn right now. */
  renderTick = 0;
  /** Current buffer, in ticks. */
  delayTicks = MAX_DELAY_TICKS;
  /** Typical variation in snapshot arrival times, in milliseconds. */
  jitterMs = 0;
  private lastArrivalMs = -1;
  private lastTick = -1;
  private started = false;

  /** Call when a snapshot for server tick `tick` arrives at local time `nowMs`. */
  onSnapshot(tick: number, nowMs: number): void {
    if (this.lastArrivalMs >= 0 && tick > this.lastTick) {
      const expected = (tick - this.lastTick) * DT * 1000;
      const actual = nowMs - this.lastArrivalMs;
      // A smoothed average of how late or early snapshots are compared with a perfect rhythm.
      this.jitterMs = this.jitterMs * 0.92 + Math.abs(actual - expected) * 0.08;
    }
    this.lastArrivalMs = nowMs;
    this.lastTick = Math.max(this.lastTick, tick);
    const wanted = MIN_DELAY_TICKS + (this.jitterMs * JITTER_MARGIN) / (DT * 1000);
    // Grow quickly when the connection gets worse, shrink slowly when it improves.
    const rate = wanted > this.delayTicks ? 0.25 : 0.02;
    this.delayTicks = clamp(this.delayTicks + (wanted - this.delayTicks) * rate, MIN_DELAY_TICKS, MAX_DELAY_TICKS);
  }

  /** Moves the drawing time forward by one frame, staying `delayTicks` behind the newest snapshot. */
  advance(frameDt: number, newestTick: number): number {
    const target = newestTick - this.delayTicks;
    if (!this.started) {
      this.renderTick = target;
      this.started = true;
      return this.renderTick;
    }
    this.renderTick += frameDt * TICK_RATE;
    const drift = target - this.renderTick;
    // Far off (a long stall): jump. Slightly off: speed up or slow down a touch to catch up.
    if (Math.abs(drift) > 15) this.renderTick = target;
    else this.renderTick += drift * 0.08;
    return this.renderTick;
  }
}
