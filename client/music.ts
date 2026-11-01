// Soft background music, generated live with the Web Audio API: warm chord pads, a quiet bass
// and a gentle arpeggio with a little echo. Nothing is downloaded and there are no licences.
//
// Notes are scheduled slightly ahead of time on the audio clock (not with setTimeout timing),
// which keeps the rhythm steady even if the game is busy.

const BPM = 84;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const LOOKAHEAD = 1.2; // seconds of music scheduled in advance
const VOLUME = 0.16;

/** A calm four-chord loop (MIDI note numbers): Am7 – Fmaj7 – Cmaj7 – G6. */
const CHORDS = [
  [57, 60, 64, 67],
  [53, 57, 60, 64],
  [48, 55, 59, 64],
  [55, 59, 62, 64],
];
/** Which chord tone the arpeggio plays on each eighth note (-1 = rest); two patterns alternate. */
const ARP_PATTERNS = [
  [0, 2, 1, 3, 2, -1, 1, 3],
  [3, -1, 2, 1, -1, 2, 0, -1],
];

const midiToHz = (n: number) => 440 * 2 ** ((n - 69) / 12);

export class Music {
  private out: GainNode;
  private padFilter: BiquadFilterNode;
  private echo: DelayNode;
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBarAt = 0;
  private bar = 0;

  constructor(
    private ctx: AudioContext,
    destination: AudioNode,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(destination);

    // Pads go through a low-pass filter so they sound soft rather than buzzy.
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 900;
    this.padFilter.Q.value = 0.4;
    this.padFilter.connect(this.out);

    // A quiet echo for the arpeggio.
    this.echo = ctx.createDelay(1);
    this.echo.delayTime.value = BEAT * 0.75;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.28;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.echo.connect(feedback).connect(this.echo);
    this.echo.connect(wet).connect(this.out);
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setTargetAtTime(VOLUME, now, 1.2); // fade in
    this.nextBarAt = now + 0.1;
    this.schedule();
    this.timer = setInterval(() => this.schedule(), 250);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.out.gain.cancelScheduledValues(this.ctx.currentTime);
    this.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4); // fade out
  }

  private schedule(): void {
    while (this.nextBarAt < this.ctx.currentTime + LOOKAHEAD) {
      this.playBar(this.nextBarAt, this.bar);
      this.nextBarAt += BAR;
      this.bar++;
    }
  }

  private playBar(t: number, bar: number): void {
    const chord = CHORDS[bar % CHORDS.length];

    // Pad: each chord note on two slightly detuned soft oscillators, swelling in and out.
    for (const note of chord) {
      for (const detune of [-6, 6]) {
        this.voice(midiToHz(note), 'triangle', t, BAR + 0.6, 0.035, 0.7, 0.9, this.padFilter, detune);
      }
    }

    // Bass: the chord's root, an octave down, on beats 1 and 3.
    for (const beat of [0, 2]) {
      this.voice(midiToHz(chord[0] - 12), 'sine', t + beat * BEAT, BEAT * 1.6, 0.12, 0.02, 0.6, this.out);
    }

    // Arpeggio: chord tones an octave up, from one of two patterns that swap every 4 bars.
    const pattern = ARP_PATTERNS[Math.floor(bar / 4) % ARP_PATTERNS.length];
    pattern.forEach((step, i) => {
      if (step < 0) return;
      const at = t + i * (BEAT / 2);
      const hz = midiToHz(chord[step] + 12);
      this.voice(hz, 'sine', at, 0.5, 0.045, 0.005, 0.45, this.out);
      this.voice(hz, 'sine', at, 0.5, 0.03, 0.005, 0.45, this.echo);
    });
  }

  /** One note with a smooth attack and release, so nothing clicks. */
  private voice(
    hz: number,
    type: OscillatorType,
    start: number,
    length: number,
    volume: number,
    attack: number,
    release: number,
    to: AudioNode,
    detune = 0,
  ): void {
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = hz;
    osc.detune.value = detune;
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(volume, start + attack);
    env.gain.setValueAtTime(volume, Math.max(start + attack, start + length - release));
    env.gain.linearRampToValueAtTime(0, start + length);
    osc.connect(env).connect(to);
    osc.start(start);
    osc.stop(start + length + 0.05);
  }
}
