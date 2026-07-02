import { GRID_COLS } from './constants.js';
import { pixelToCol } from './layout.js';

export type InputIntent =
  | { kind: 'drop'; col: number }
  | { kind: 'move'; col: number }
  | { kind: 'restart' };

export class InputHandler {
  private canvas: HTMLCanvasElement;
  private onIntent: (intent: InputIntent) => void;
  private isGameOver: () => boolean;
  // InputHandler tracks its own cursor column so keyboard moves (+1/-1) can be
  // computed without coupling to GameState. The game's cursorCol stays in sync
  // because every 'move' intent is forwarded to the game, which updates it too.
  private cursorCol = 3;
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
  ) {
    this.canvas      = canvas;
    this.onIntent    = onIntent;
    this.isGameOver  = isGameOver;
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
      switch (e.key) {
        case 'ArrowLeft':
        case 'h':
          e.preventDefault();
          this.emit({ kind: 'move', col: Math.max(0, this.cursorCol - 1) });
          break;
        case 'ArrowRight':
        case 'l':
          e.preventDefault();
          this.emit({ kind: 'move', col: Math.min(GRID_COLS - 1, this.cursorCol + 1) });
          break;
        case 'ArrowDown':
        case ' ':
        case 'Enter':
          e.preventDefault();
          this.emit({ kind: 'drop', col: this.cursorCol });
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
    if (intent.kind === 'move') {
      this.cursorCol = intent.col;
    }
    this.onIntent(intent);
  }

  destroy(): void {
    this.abortCtrl.abort();
  }
}
