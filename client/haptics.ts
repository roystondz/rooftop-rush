// Short vibrations on phones for shots, tackles and goals. Android browsers support this; iPhones
// don't (Safari has no vibration API), so there it quietly does nothing.

export class Haptics {
  enabled = true;
  readonly supported: boolean;

  constructor(touchDevice: boolean) {
    this.supported = touchDevice && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  }

  /** Milliseconds to vibrate, or [on, off, on, …]. */
  buzz(pattern: number | number[]): void {
    if (!this.enabled || !this.supported) return;
    try {
      navigator.vibrate(pattern);
    } catch {
      // Some browsers throw if the page hasn't been tapped yet; a missed buzz doesn't matter.
    }
  }
}

/** How each moment feels. Kept short: a phone buzzing constantly gets annoying fast. */
export const BUZZ = {
  shot: 12,
  powerShot: [30, 30, 40],
  tackle: 25,
  post: 20,
  save: 30,
  goalFor: [50, 40, 50, 40, 140],
  goalAgainst: 90,
} as const;
