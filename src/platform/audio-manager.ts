export class AudioManager {
  private ctx: AudioContext | null = null;

  private init(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  private beep(freq: number, dur: number, gain: number, type: OscillatorType = 'sine'): void {
    try {
      const ctx  = this.init();
      const osc  = ctx.createOscillator();
      const env  = ctx.createGain();
      osc.type   = type;
      osc.frequency.value = freq;
      env.gain.setValueAtTime(gain, ctx.currentTime);
      env.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      osc.connect(env);
      env.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + dur);
    } catch {
      // Silently ignore audio errors
    }
  }

  playDrop(): void {
    this.beep(220, 0.08, 0.25, 'triangle');
  }

  playClear(chainLevel: number): void {
    const base  = 440;
    const freq  = base * (1 + chainLevel * 0.3);
    const gain  = Math.min(0.5, 0.25 + chainLevel * 0.05);
    this.beep(freq, 0.18, gain, 'sine');
  }

  playReveal(): void {
    this.beep(330, 0.12, 0.2, 'triangle');
  }

  playGameOver(): void {
    this.beep(110, 0.6, 0.35, 'sawtooth');
  }

  playPush(): void {
    this.beep(160, 0.15, 0.2, 'square');
  }
}
