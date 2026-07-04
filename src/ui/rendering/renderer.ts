import type { Board, Disc } from '../../game/model.js';
import { DiscKind } from '../../game/model.js';
import type { GameState } from '../../game/state.js';
import { GamePhase } from '../../game/state.js';
import type { RichDiscAnimation, ScorePopup } from './animation-types.js';
import {
  GRID_COLS, GRID_ROWS,
  DISC_COLORS,
  COLOR_BG, COLOR_GRID_CELL, COLOR_GRID_LINE,
  COLOR_CRACKED_FILL, COLOR_CRACKED_DARK, COLOR_CRACK_LINE,
  COLOR_TEXT, COLOR_TEXT_DIM, COLOR_GHOST, COLOR_COL_HOVER,
  COLOR_GAMEOVER_BG, COLOR_SCORE_POPUP, HUD_TOP_HEIGHT,
} from './theme.js';
import {
  cellCenterX, cellCenterY, gridOriginX, gridOriginY,
  canvasLogicalWidth, canvasLogicalHeight, gridW, gridH,
  gridPadding, cellSize, updateCellSize,
} from './layout.js';
import { interpolateY, interpolateX } from './animation-queue.js';
import type { GameStats } from '../../game/stats.js';

const HUD_BOTTOM_HEIGHT = 80;

// Computed each draw call so it stays proportional after a resize.
function discR(): number { return cellSize() / 2 - Math.max(3, cellSize() * 0.07); }

const isTouchDevice = () => ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not get 2D context');
    this.ctx = ctx;
    this.resize();
  }

  resize(): void {
    // Recompute cell size first — all geometry functions depend on it.
    updateCellSize();
    this.dpr = window.devicePixelRatio || 1;
    const lw = canvasLogicalWidth();
    const lh = canvasLogicalHeight();
    // Set the backing-store size in physical pixels.
    this.canvas.width  = Math.round(lw * this.dpr);
    this.canvas.height = Math.round(lh * this.dpr);
    // CSS size stays at logical pixels so the canvas looks the right size on screen.
    this.canvas.style.width  = `${lw}px`;
    this.canvas.style.height = `${lh}px`;
    // setTransform (not scale) resets all existing transforms before applying DPR
    // scaling, preventing cumulative scaling if resize() is called more than once.
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  // board is the visual board (pre-physics snapshot advanced step-by-step), not
  // state.board (which is already in the final post-physics state). Drawing from
  // the visual board prevents discs from teleporting to their final positions
  // during intermediate animation steps like Clear and Fall.
  draw(
    state: GameState,
    board: Board,
    animations: readonly RichDiscAnimation[],
    stats: GameStats,
    displayScore: number,
    scorePopups: readonly ScorePopup[],
    initialTurnsPerLevel: number,
  ): void {
    const { ctx } = this;
    // Build a set of disc IDs currently being animated. drawStaticDiscs uses
    // this to skip those cells — without it a disc would be drawn twice: once
    // at its board position and once at its interpolated animation position.
    const animIds = new Set(animations.map(a => a.discId));

    ctx.clearRect(0, 0, canvasLogicalWidth(), canvasLogicalHeight());
    this.drawBackground();
    if (state.phase === GamePhase.Menu) return; // DOM overlay owns the screen entirely
    this.drawGrid(state.cursorCol);
    this.drawStaticDiscs(board, animIds);
    this.drawAnimatedDiscs(animations);
    this.drawScorePopups(scorePopups);
    this.drawGhost(state.cursorCol, state.currentDisc, board);
    this.drawHUD(state, displayScore, initialTurnsPerLevel);

    if (state.phase === GamePhase.GameOver) {
      this.drawGameOver(state.score, stats);
    }
  }

  private drawBackground(): void {
    this.ctx.fillStyle = COLOR_BG;
    this.ctx.fillRect(0, 0, canvasLogicalWidth(), canvasLogicalHeight());
  }

  private drawGrid(cursorCol: number): void {
    const { ctx } = this;
    const ox = gridOriginX();
    const oy = gridOriginY();
    const cs = cellSize();

    // Column highlight drawn first so cell backgrounds paint over the edges.
    ctx.fillStyle = COLOR_COL_HOVER;
    ctx.fillRect(ox + cursorCol * cs, oy, cs, gridH());

    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        ctx.fillStyle = COLOR_GRID_CELL;
        ctx.beginPath();
        ctx.roundRect(ox + c * cs + 2, oy + r * cs + 2, cs - 4, cs - 4, 6);
        ctx.fill();
      }
    }

    ctx.strokeStyle = COLOR_GRID_LINE;
    ctx.lineWidth = 1;
    for (let c = 0; c <= GRID_COLS; c++) {
      ctx.beginPath();
      ctx.moveTo(ox + c * cs, oy);
      ctx.lineTo(ox + c * cs, oy + gridH());
      ctx.stroke();
    }
    for (let r = 0; r <= GRID_ROWS; r++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + r * cs);
      ctx.lineTo(ox + gridW(), oy + r * cs);
      ctx.stroke();
    }
  }

  private drawStaticDiscs(board: Board, animIds: Set<number>): void {
    for (let r = 0; r < GRID_ROWS; r++) {
      for (let c = 0; c < GRID_COLS; c++) {
        const disc = board[r]![c];
        if (!disc || animIds.has(disc.id)) continue;
        this.drawDisc(disc, cellCenterX(c), cellCenterY(r), discR(), 1, 1);
      }
    }
  }

  private drawAnimatedDiscs(animations: readonly RichDiscAnimation[]): void {
    for (const anim of animations) {
      const x = interpolateX(anim);
      const y = interpolateY(anim);
      this.drawDisc(anim.disc, x, y, discR(), anim.alpha, anim.scale);
    }
  }

  private drawScorePopups(popups: readonly ScorePopup[]): void {
    const { ctx } = this;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 18px system-ui, sans-serif';
    for (const p of popups) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, p.alpha));
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 4;
      ctx.fillStyle = COLOR_SCORE_POPUP;
      ctx.fillText(`+${p.value}`, cellCenterX(p.col), cellCenterY(p.row) - p.yOffset);
      ctx.restore();
    }
  }

  private drawGhost(cursorCol: number, disc: Disc, board: Board): void {
    // Reproduce the same bottom-up scan as landingRow() to show where the
    // current disc would actually land if the player drops here.
    let landRow = -1;
    for (let r = GRID_ROWS - 1; r >= 0; r--) {
      if (board[r]![cursorCol] === null) { landRow = r; break; }
    }
    if (landRow < 0) return; // column full — no ghost

    const cx = cellCenterX(cursorCol);
    const cy = cellCenterY(landRow);
    this.drawDisc(disc, cx, cy, discR(), 0.28, 1);

    // Dashed guide line from the top of the grid down to just above the ghost.
    const { ctx } = this;
    ctx.strokeStyle = COLOR_GHOST;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(cx, gridOriginY());
    ctx.lineTo(cx, cy - discR() - 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawHUD(state: GameState, displayScore: number, initialTurnsPerLevel: number): void {
    const { ctx } = this;
    const lw = canvasLogicalWidth();
    const gp = gridPadding();

    // Score — centered across the top of the canvas.
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(displayScore), lw / 2, HUD_TOP_HEIGHT * 0.25);

    // Turn pips — one circle per turn in the current level, filled while unused.
    // A push happens the instant these run out, so this line doubles as the
    // push countdown — no separate readout needed.
    this.drawTurnPips(
      state.turnsRemaining,
      state.turnsPerLevel,
      initialTurnsPerLevel,
      HUD_TOP_HEIGHT * 0.6,
    );

    // Level, directly below the turn pips.
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillStyle = COLOR_TEXT_DIM;
    ctx.textAlign = 'center';
    ctx.fillText(`LVL ${state.level}`, lw / 2, HUD_TOP_HEIGHT * 0.88);

    const bottomY = gridOriginY() + gridH() + 8;
    const hudCy = bottomY + HUD_BOTTOM_HEIGHT / 2;
    const r = discR();

    ctx.fillStyle = COLOR_TEXT_DIM;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    ctx.fillText('NOW', gp, hudCy - 16);
    this.drawDisc(state.currentDisc, gp + r + 4, hudCy + 2, r * 0.55, 1, 1);

    ctx.fillText('NEXT', gp + r * 2 + 16, hudCy - 16);
    this.drawDisc(state.nextDisc, gp + r * 3 + 20, hudCy + 2, r * 0.4, 1, 1);

    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = COLOR_TEXT_DIM;
    ctx.textAlign = 'right';
    // Show tap hint on touch devices, keyboard hint on desktop.
    const hint = isTouchDevice()
      ? 'tap column to drop'
      : '← → move  ↓ / click drop  R restart';
    ctx.fillText(hint, lw - gp, hudCy + 8);
  }

  // Circle size and spacing are based on the first level's turn budget and stay
  // fixed for the whole game. Later levels therefore occupy less width as their
  // budgets shrink instead of stretching fewer pips back across the full grid.
  // Filled = not yet taken, hollow = already used; pips deplete right to left.
  private drawTurnPips(remaining: number, total: number, scaleTotal: number, cy: number): void {
    if (total <= 0 || scaleTotal <= 0) return;
    const { ctx } = this;
    const gx0 = gridOriginX();
    const width = gridW();
    const r = Math.min(7, Math.max(2.5, width / scaleTotal / 2 - 1.5));
    const step = scaleTotal > 1 ? (width - r * 2) / (scaleTotal - 1) : 0;
    const usedCount = total - remaining;

    for (let i = 0; i < total; i++) {
      const cx = gx0 + r + step * i;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      if (i >= total - usedCount) {
        ctx.strokeStyle = COLOR_TEXT_DIM;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = COLOR_TEXT;
        ctx.fill();
      }
    }
  }

  private drawGameOver(score: number, stats: GameStats): void {
    const { ctx } = this;
    const lw = canvasLogicalWidth();
    const lh = canvasLogicalHeight();

    ctx.fillStyle = COLOR_GAMEOVER_BG;
    ctx.fillRect(0, 0, lw, lh);

    ctx.fillStyle = COLOR_TEXT;
    ctx.font = 'bold 38px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('GAME OVER', lw / 2, lh / 2 - 68);

    ctx.font = '22px system-ui, sans-serif';
    ctx.fillText(`Score: ${score}`, lw / 2, lh / 2 - 28);

    ctx.font = '14px system-ui, sans-serif';
    ctx.fillStyle = COLOR_TEXT_DIM;
    ctx.fillText(`High ${stats.highScore}   •   Longest chain ${stats.longestStreak}`, lw / 2, lh / 2 + 8);
    ctx.fillText(`Average ${stats.averageScore} over ${stats.gamesPlayed} game${stats.gamesPlayed === 1 ? '' : 's'}`, lw / 2, lh / 2 + 30);

    const restartHint = isTouchDevice() ? 'Tap to restart' : 'Press R to restart';
    ctx.fillText(restartHint, lw / 2, lh / 2 + 66);
  }

  drawDisc(disc: Disc, cx: number, cy: number, r: number, alpha: number, scale: number): void {
    const { ctx } = this;
    ctx.save();
    // Canvas 2D throws a RangeError if globalAlpha is outside [0, 1].
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);

    if (disc.kind === DiscKind.Numbered) {
      drawNumberedDisc(ctx, disc.value, r);
    } else {
      drawCrackedDisc(ctx, disc.kind, r);
    }

    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Pure canvas drawing helpers — no state, no side effects beyond ctx mutations
// ---------------------------------------------------------------------------

function drawNumberedDisc(ctx: CanvasRenderingContext2D, value: number, r: number): void {
  // Falls back to grey if value is somehow out of 1–7 range.
  const color = DISC_COLORS[value - 1] ?? '#888888';

  // Shadow is set before the fill so the glow appears under the disc.
  // It's cleared before the stroke so the border doesn't get blurred too.
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur  = 8;

  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  // Off-center radial gradient simulates a light source from the upper-left.
  const grad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.05, 0, 0, r);
  grad.addColorStop(0, lighten(color, 0.35));
  grad.addColorStop(1, color);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${Math.round(r * 1.15)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // +1px vertical nudge compensates for the optical illusion where centered
  // text looks slightly high due to descenders in the font metrics.
  ctx.fillText(String(value), 0, 1);
}

function drawCrackedDisc(ctx: CanvasRenderingContext2D, kind: DiscKind, r: number): void {
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur  = 8;

  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  const grad = ctx.createRadialGradient(-r * 0.25, -r * 0.25, r * 0.05, 0, 0, r);
  grad.addColorStop(0, COLOR_CRACKED_FILL);
  grad.addColorStop(1, COLOR_CRACKED_DARK);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.strokeStyle = COLOR_CRACK_LINE;
  ctx.lineWidth   = 1.8;
  ctx.lineCap     = 'round';

  // Two-segment path with a slight bend gives each crack a more natural,
  // irregular look compared to a straight line.
  ctx.beginPath();
  ctx.moveTo(-r * 0.2, -r * 0.55);
  ctx.lineTo(-r * 0.03, -r * 0.1);
  ctx.lineTo( r * 0.28,  r * 0.58);
  ctx.stroke();

  if (kind === DiscKind.DoubleCracked) {
    // Second crack crosses the first, visually distinguishing double from single.
    ctx.beginPath();
    ctx.moveTo( r * 0.38, -r * 0.48);
    ctx.lineTo( r * 0.06, -r * 0.05);
    ctx.lineTo(-r * 0.32,  r * 0.52);
    ctx.stroke();
  }
}

// Adds a fixed amount of brightness to each RGB channel of a 6-digit hex color.
function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 0xff) + Math.round(255 * amount));
  const g = Math.min(255, ((n >> 8)  & 0xff) + Math.round(255 * amount));
  const b = Math.min(255, ( n        & 0xff) + Math.round(255 * amount));
  return `rgb(${r},${g},${b})`;
}
