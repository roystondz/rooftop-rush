// All sounds are synthesised with the Web Audio API, so there are no audio files to license.

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private crowd: { gain: GainNode } | null = null;
  muted = false;

  /** Browsers only allow audio after a click or key press, so call this from one. */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.6;
    this.master.connect(ctx.destination);

    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.startCrowd();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(muted ? 0 : 0.6, this.ctx.currentTime, 0.05);
  }

  kick(strength = 0.5): void {
    this.thump(140 + strength * 60, 0.12, 0.5 + strength * 0.5);
    this.burst(0.05, 2500, 0.2 + strength * 0.3);
  }

  powerKick(): void {
    this.thump(90, 0.3, 1);
    this.sweep(300, 1400, 0.35, 0.25);
    this.burst(0.25, 1200, 0.5);
  }

  pass(): void {
    this.thump(220, 0.08, 0.35);
  }

  bounce(strength = 0.5): void {
    this.thump(110, 0.08, Math.min(0.5, strength * 0.08));
  }

  post(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    for (const f of [520, 1310, 2150]) this.tone(f, 'sine', 0.6, 0.12);
  }

  tackle(): void {
    this.burst(0.15, 600, 0.6);
    this.thump(80, 0.15, 0.6);
  }

  whistle(long = false): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const dur = long ? 0.9 : 0.4;
    const osc = ctx.createOscillator();
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    const g = ctx.createGain();
    osc.frequency.value = 2900;
    lfo.frequency.value = 28;
    lfoGain.gain.value = 120;
    lfo.connect(lfoGain).connect(osc.frequency);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.02);
    g.gain.setValueAtTime(0.12, t + dur - 0.05);
    g.gain.linearRampToValueAtTime(0, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + dur);
    lfo.stop(t + dur);
  }

  goal(): void {
    this.burst(2.5, 900, 0.9, 0.3);
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.tone(f, 'triangle', 0.4, 0.15), i * 90));
  }

  rushReady(): void {
    [660, 880, 1320].forEach((f, i) => setTimeout(() => this.tone(f, 'square', 0.15, 0.06), i * 70));
  }

  /** Raises the crowd for a moment (near misses, big chances). */
  crowdSwell(amount = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.crowd) return;
    const g = this.crowd.gain.gain;
    g.cancelScheduledValues(ctx.currentTime);
    g.setTargetAtTime(0.05 + 0.12 * amount, ctx.currentTime, 0.1);
    g.setTargetAtTime(0.05, ctx.currentTime + 0.8, 0.6);
  }

  private startCrowd(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 700;
    filter.Q.value = 0.6;
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    this.crowd = { gain };
  }

  private thump(freq: number, dur: number, vol: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * 0.4), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur);
  }

  private burst(dur: number, freq: number, vol: number, attack = 0.005): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + attack);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur);
  }

  private sweep(from: number, to: number, dur: number, vol: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur);
  }

  private tone(freq: number, type: OscillatorType, dur: number, vol: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur);
  }
}
