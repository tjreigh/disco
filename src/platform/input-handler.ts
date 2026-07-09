import { pixelToCol } from '../ui/rendering/layout.js';

export type InputIntent =
  | { kind: 'drop'; col: number }
  | { kind: 'move'; col: number }
  | { kind: 'restart' };

export class InputHandler {
  private canvas: HTMLCanvasElement;
  private onIntent: (intent: InputIntent) => void;
  private isGameOver: () => boolean;
  private getCursorCol: () => number;
  private touchStartX = 0;
  private touchStartY = 0;
  private touchStartTime = 0;
  // Single AbortController removes all listeners atomically on destroy(),
  // avoiding the need to store individual listener references.
  private abortCtrl = new AbortController();

  constructor(
    canvas: HTMLCanvasElement,
    onIntent: (intent: InputIntent) => void,
    isGameOver: () => boolean,
    getCursorCol: () => number,
  ) {
    this.canvas      = canvas;
    this.onIntent    = onIntent;
    this.isGameOver  = isGameOver;
    this.getCursorCol = getCursorCol;
    this.attach();
  }

  private attach(): void {
    const sig = { signal: this.abortCtrl.signal };

    this.canvas.addEventListener('mousemove', (e: MouseEvent) => {
      const col = pixelToCol(this.canvas.getBoundingClientRect(), e.clientX);
      if (col !== null) this.emit({ kind: 'move', col });
    }, sig);

    this.canvas.addEventListener('click', (e: MouseEvent) => {
      const col = pixelToCol(this.canvas.getBoundingClientRect(), e.clientX);
      if (col !== null) this.emit({ kind: 'drop', col });
    }, sig);

    document.addEventListener('keydown', (e: KeyboardEvent) => {
      // Game keys must not fire while the user is interacting with a focusable
      // control (e.g. the debug panel's textarea or its keyboard-focusable flag
      // cells) — only dispatch when focus is on a non-interactive element such
      // as document.body or the canvas (both default to tabIndex -1).
      if (e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.tabIndex >= 0)) return;

      switch (e.key) {
        case 'ArrowLeft':
        case 'h':
          e.preventDefault();
          this.emit({ kind: 'move', col: this.getCursorCol() - 1 });
          break;
        case 'ArrowRight':
        case 'l':
          e.preventDefault();
          this.emit({ kind: 'move', col: this.getCursorCol() + 1 });
          break;
        case 'ArrowDown':
        case ' ':
        case 'Enter':
          e.preventDefault();
          this.emit({ kind: 'drop', col: this.getCursorCol() });
          break;
        case 'r':
        case 'R':
          this.emit({ kind: 'restart' });
          break;
      }
    }, sig);

    // passive: false is required to allow e.preventDefault() inside the handler.
    // Browsers silently ignore preventDefault() on passive listeners, which would
    // let touch events scroll or zoom the page while the player is dragging.
    this.canvas.addEventListener('touchstart', (e: TouchEvent) => {
      e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      this.touchStartX    = t.clientX;
      this.touchStartY    = t.clientY;
      this.touchStartTime = Date.now();
      const col = pixelToCol(this.canvas.getBoundingClientRect(), t.clientX);
      if (col !== null) this.emit({ kind: 'move', col });
    }, { ...sig, passive: false });

    this.canvas.addEventListener('touchmove', (e: TouchEvent) => {
      e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      const col = pixelToCol(this.canvas.getBoundingClientRect(), t.clientX);
      if (col !== null) this.emit({ kind: 'move', col });
    }, { ...sig, passive: false });

    this.canvas.addEventListener('touchend', (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!t) return;
      const dt   = Date.now() - this.touchStartTime;
      const dist = Math.hypot(t.clientX - this.touchStartX, t.clientY - this.touchStartY);
      // Only fire for a tap (short, low-movement touch). Swipes are ignored so
      // dragging to reposition doesn't accidentally drop a disc.
      if (dt < 300 && dist < 14) {
        // On the game-over screen a tap anywhere restarts instead of dropping.
        if (this.isGameOver()) {
          this.emit({ kind: 'restart' });
          return;
        }
        const col = pixelToCol(this.canvas.getBoundingClientRect(), t.clientX);
        if (col !== null) this.emit({ kind: 'drop', col });
      }
    }, sig);
  }

  private emit(intent: InputIntent): void {
    this.onIntent(intent);
  }

  destroy(): void {
    this.abortCtrl.abort();
  }
}
