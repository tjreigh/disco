// Web Audio SFX. Browsers suspend the AudioContext when the page is backgrounded
// and don't reliably resume it on return; the listeners below bring it back, and
// beep() refuses to schedule into a context that isn't running (see the comment
// there for why a suspended context turns queued sounds into a burst).

const liveContexts = new Set<AudioContext>();

function isSuspended(ctx: AudioContext): boolean {
  // 'interrupted' is an iOS-only state not in the lib types.
  return ctx.state === 'suspended' || (ctx.state as string) === 'interrupted';
}

function resumeLiveContexts(): void {
  for (const ctx of liveContexts) {
    if (isSuspended(ctx)) void ctx.resume?.().catch(() => {});
  }
}

let lifecycleBound = false;
function bindLifecycleOnce(): void {
  if (lifecycleBound || typeof window === 'undefined' || typeof document === 'undefined') return;
  lifecycleBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resumeLiveContexts();
  });
  window.addEventListener('focus', resumeLiveContexts);
  window.addEventListener('pageshow', resumeLiveContexts);
  // A user gesture is the only path that reliably un-suspends an AudioContext on
  // mobile (and on desktop when the tab was shown without a focus event). These
  // stay bound: the context can re-suspend on every background, so one-shot
  // unlocking isn't enough. All passive, all cheap.
  const onGesture = (): void => resumeLiveContexts();
  window.addEventListener('pointerdown', onGesture, { passive: true });
  window.addEventListener('keydown', onGesture, { passive: true });
  window.addEventListener('touchstart', onGesture, { passive: true });
}

export class AudioManager {
  private ctx: AudioContext | null = null;
  private enabled = true;

  private init(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      liveContexts.add(this.ctx);
      bindLifecycleOnce();
      // A freshly constructed context starts 'suspended' under the autoplay
      // policy; nudge it now so the first sound has a chance to land.
      if (isSuspended(this.ctx)) void this.ctx.resume?.().catch(() => {});
      // Recover from an iOS audio interruption that ended while we're foreground.
      this.ctx.addEventListener?.('statechange', () => {
        if (typeof document === 'undefined' || document.visibilityState === 'visible') {
          resumeLiveContexts();
        }
      });
    }
    return this.ctx;
  }

  private beep(freq: number, dur: number, gain: number, type: OscillatorType = 'sine'): void {
    if (!this.enabled) return;
    try {
      const ctx  = this.init();
      if (ctx.state !== 'running') {
        // Don't schedule into a suspended context. Its currentTime is frozen, so
        // every oscillator we'd start here stacks onto the same timestamp and
        // then fires simultaneously the moment the context resumes — the "burst
        // of sounds after navigating back" bug. Kick a resume and drop this one;
        // SFX are ephemeral and a late beep is worse than a missing one.
        void ctx.resume?.().catch(() => {});
        return;
      }
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

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  toggleEnabled(): boolean {
    this.enabled = !this.enabled;
    return this.enabled;
  }

  dispose(): void {
    if (!this.ctx) return;
    liveContexts.delete(this.ctx);
    void this.ctx.close?.().catch(() => {});
    this.ctx = null;
  }
}
