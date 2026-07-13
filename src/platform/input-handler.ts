import { pixelToCol, pixelToRow } from '../ui/rendering/layout.js';

export type InputIntent =
  // `col` is the generic lane cursor: a column index normally, or a row index
  // when the current entry edge is left/right (Gravity mode only).
  | { kind: 'drop'; col: number }
  | { kind: 'move'; col: number }
  | { kind: 'tilt'; delta: number }
  | { kind: 'cancel' }
  | { kind: 'restart' };

const TILT_STEP_DEG = 45;

export class InputHandler {
  private canvas: HTMLCanvasElement;
  private onIntent: (intent: InputIntent) => void;
  private getCursorCol: () => number;
  private getAxis: () => 'col' | 'row';
  private touchStartX = 0;
  private touchStartY = 0;
  private touchStartTime = 0;
  // Single AbortController removes all listeners atomically on destroy(),
  // avoiding the need to store individual listener references.
  private abortCtrl = new AbortController();

  constructor(
    canvas: HTMLCanvasElement,
    onIntent: (intent: InputIntent) => void,
    getCursorCol: () => number,
    getAxis: () => 'col' | 'row' = () => 'col',
  ) {
    this.canvas      = canvas;
    this.onIntent    = onIntent;
    this.getCursorCol = getCursorCol;
    this.getAxis = getAxis;
    this.attach();
  }

  // Column index for pointer position on the 'col' axis, row index on 'row'.
  private pixelToLane(clientX: number, clientY: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    return this.getAxis() === 'row' ? pixelToRow(rect, clientY) : pixelToCol(rect, clientX);
  }

  private attach(): void {
    const sig = { signal: this.abortCtrl.signal };

    this.canvas.addEventListener('mousemove', (e: MouseEvent) => {
      const lane = this.pixelToLane(e.clientX, e.clientY);
      if (lane !== null) this.emit({ kind: 'move', col: lane });
    }, sig);

    this.canvas.addEventListener('click', (e: MouseEvent) => {
      const lane = this.pixelToLane(e.clientX, e.clientY);
      if (lane !== null) this.emit({ kind: 'drop', col: lane });
    }, sig);

    document.addEventListener('keydown', (e: KeyboardEvent) => {
      // Game keys must not fire while the user is interacting with a focusable
      // control (e.g. the debug panel's textarea or its keyboard-focusable flag
      // cells) — only dispatch when focus is on a non-interactive element such
      // as document.body or the canvas (both default to tabIndex -1).
      if (e.target instanceof HTMLElement && (e.target.isContentEditable || e.target.tabIndex >= 0)) return;

      const axis = this.getAxis();
      switch (e.key) {
        case 'ArrowLeft':
        case 'h':
          if (axis !== 'col') break;
          e.preventDefault();
          this.emit({ kind: 'move', col: this.getCursorCol() - 1 });
          break;
        case 'ArrowRight':
        case 'l':
          if (axis !== 'col') break;
          e.preventDefault();
          this.emit({ kind: 'move', col: this.getCursorCol() + 1 });
          break;
        case 'ArrowUp':
        case 'k':
          if (axis !== 'row') break;
          e.preventDefault();
          this.emit({ kind: 'move', col: this.getCursorCol() - 1 });
          break;
        case 'ArrowDown':
        case 'j':
          if (axis === 'row') {
            e.preventDefault();
            this.emit({ kind: 'move', col: this.getCursorCol() + 1 });
            break;
          }
          e.preventDefault();
          this.emit({ kind: 'drop', col: this.getCursorCol() });
          break;
        case ' ':
        case 'Enter':
          e.preventDefault();
          this.emit({ kind: 'drop', col: this.getCursorCol() });
          break;
        case 'q':
        case 'Q':
          e.preventDefault();
          this.emit({ kind: 'tilt', delta: -TILT_STEP_DEG });
          break;
        case 'e':
        case 'E':
          e.preventDefault();
          this.emit({ kind: 'tilt', delta: TILT_STEP_DEG });
          break;
        case 'r':
        case 'R':
          this.emit({ kind: 'restart' });
          break;
        case 'Escape':
          e.preventDefault();
          this.emit({ kind: 'cancel' });
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
      const lane = this.pixelToLane(t.clientX, t.clientY);
      if (lane !== null) this.emit({ kind: 'move', col: lane });
    }, { ...sig, passive: false });

    this.canvas.addEventListener('touchmove', (e: TouchEvent) => {
      e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      const lane = this.pixelToLane(t.clientX, t.clientY);
      if (lane !== null) this.emit({ kind: 'move', col: lane });
    }, { ...sig, passive: false });

    this.canvas.addEventListener('touchend', (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!t) return;
      const dt   = Date.now() - this.touchStartTime;
      const dist = Math.hypot(t.clientX - this.touchStartX, t.clientY - this.touchStartY);
      // Only fire for a tap (short, low-movement touch). Swipes are ignored so
      // dragging to reposition doesn't accidentally drop a disc.
      if (dt < 300 && dist < 14) {
        const lane = this.pixelToLane(t.clientX, t.clientY);
        if (lane !== null) this.emit({ kind: 'drop', col: lane });
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
