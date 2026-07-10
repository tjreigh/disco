import type { Board, Disc, EntryEdge, GridPos } from '../../game/model.js';
import { DiscKind } from '../../game/model.js';
import type { GameState, GravityState } from '../../game/state.js';
import { GamePhase } from '../../game/state.js';
import {
  computeGravityVector, entryEdgeForAngle,
  offBoardEntryPosition, snapAngleToEightDirections,
} from '../../game/gravity.js';
import type { RichDiscAnimation, ScoreIndicator, ScorePopup } from './animation-types.js';
import {
  DISC_COLORS,
  COLOR_BG, COLOR_GRID_CELL, COLOR_GRID_LINE,
  COLOR_CRACKED_FILL, COLOR_CRACKED_DARK, COLOR_CRACK_LINE,
  COLOR_TEXT, COLOR_TEXT_DIM, COLOR_GHOST, COLOR_COL_HOVER,
  COLOR_GAMEOVER_BG, COLOR_SCORE_POPUP, COLOR_GRAVITY_ACCENT, COLOR_GRAVITY_LANE,
  HUD_TOP_HEIGHT, HUD_BOTTOM_HEIGHT,
} from './theme.js';
import {
  cellCenterX, cellCenterY, gridOriginX, gridOriginY,
  canvasLogicalWidth, canvasLogicalHeight, gridW, gridH,
  gridPadding, cellSize, updateCellSize, gridCols, gridRows,
} from './layout.js';
import { interpolateY, interpolateX, pushBoardOffsetX, pushBoardOffsetY } from './animation-queue.js';
import type { GameStats } from '../../game/stats.js';

interface LevelProgressDisplay {
  level: number;
  turnsPerLevel: number;
  turnsRemaining: number;
}

export interface TutorialVisualState {
  allowedCols: readonly number[];
}

// Computed each draw call so it stays proportional after a resize.
function discR(): number { return cellSize() / 2 - Math.max(3, cellSize() * 0.07); }

const isTouchDevice = () => ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

// Row cursor/lanes when gravity currently enters from the side, column
// cursor/lanes otherwise (Classic, or Gravity mode pointing mostly up/down).
function axisForGravity(gravity: GravityState | undefined): 'col' | 'row' {
  if (!gravity) return 'col';
  const entryEdge = entryEdgeForAngle(gravity.angle);
  return entryEdge === 'left' || entryEdge === 'right' ? 'row' : 'col';
}

// gravity.ts's angle convention (0 = down, clockwise) to canvas's arc()
// convention (0 = positive X axis, clockwise via increasing angle).
function canvasAngleRad(gravityAngleDeg: number): number {
  return ((90 - gravityAngleDeg) * Math.PI) / 180;
}

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
    scoreIndicators: readonly ScoreIndicator[],
    initialTurnsPerLevel: number,
    levelProgress: LevelProgressDisplay,
    tutorial?: TutorialVisualState | null,
    previewLanding?: GridPos | null,
  ): void {
    const { ctx } = this;
    // Build a set of disc IDs currently being animated. drawStaticDiscs uses
    // this to skip those cells — without it a disc would be drawn twice: once
    // at its board position and once at its interpolated animation position.
    const animIds = new Set(animations.map(a => a.discId));

    ctx.clearRect(0, 0, canvasLogicalWidth(), canvasLogicalHeight());
    this.drawBackground();
    if (state.phase === GamePhase.Menu) return; // DOM overlay owns the screen entirely
    if (state.gravity) this.drawGravityAmbient(state.gravity);
    const showCursor = state.phase === GamePhase.WaitingForDrop;
    const axis = axisForGravity(state.gravity);
    const entryEdge = state.gravity ? entryEdgeForAngle(state.gravity.angle) : null;
    this.drawGrid(state.cursorCol, showCursor, axis, tutorial ?? null, entryEdge);
    if (state.gravity) this.drawDiagonalLanesIfActive(state.gravity.angle);
    // During Aiming, `board` is already the live settle preview (the caller
    // substitutes it) — drawn through the same static-disc path as any other
    // committed board, no separate staged-disc rendering needed.
    this.drawStaticDiscs(board, animations, animIds);
    this.drawAnimatedDiscs(animations);
    this.drawScorePopups(scorePopups);
    this.drawScoreIndicators(scoreIndicators);
    if (showCursor) {
      this.drawGhost(state, board, previewLanding ?? null);
    }
    this.drawHUD(state, displayScore, initialTurnsPerLevel, levelProgress);
    if (state.gravity) {
      // Anchored to the top HUD band, not the grid, so it never covers a
      // playable cell — large and unmissable rather than a small icon.
      this.drawGravityCompass(state, canvasLogicalWidth() - gridPadding() - 36, HUD_TOP_HEIGHT * 0.5);
    }

    if (state.phase === GamePhase.GameOver) {
      this.drawGameOver(state.score, stats);
    }
  }

  private drawBackground(): void {
    this.ctx.fillStyle = COLOR_BG;
    this.ctx.fillRect(0, 0, canvasLogicalWidth(), canvasLogicalHeight());
  }

  // A directional wash across the grid so "down" reads at a glance without
  // hunting for the compass — sweeps from transparent (anti-gravity edge) to
  // a faint accent tint (gravity edge). Purely ambient, drawn under the grid
  // cells/discs so it never competes with gameplay content for legibility.
  private drawGravityAmbient(gravity: GravityState): void {
    const { ctx } = this;
    const { gx, gy } = computeGravityVector(gravity.angle);
    const cx = gridOriginX() + gridW() / 2;
    const cy = gridOriginY() + gridH() / 2;
    const radius = Math.max(gridW(), gridH()) * 0.8;
    const gradient = ctx.createLinearGradient(cx - gx * radius, cy - gy * radius, cx + gx * radius, cy + gy * radius);
    // rgba form of COLOR_GRAVITY_ACCENT (#62b0e8) — canvas gradients need
    // per-stop alpha, which a hex constant alone can't express.
    gradient.addColorStop(0, 'rgba(98, 176, 232, 0)');
    gradient.addColorStop(0.6, 'rgba(98, 176, 232, 0)');
    gradient.addColorStop(1, 'rgba(98, 176, 232, 0.20)');
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(gridOriginX(), gridOriginY(), gridW(), gridH());
    ctx.restore();
  }

  private drawGrid(
    cursorLane: number, showCursor: boolean, axis: 'col' | 'row',
    tutorial: TutorialVisualState | null, entryEdge: EntryEdge | null,
  ): void {
    const { ctx } = this;
    const ox = gridOriginX();
    const oy = gridOriginY();
    const cs = cellSize();

    if (showCursor) {
      // Lane highlight drawn first so cell backgrounds paint over the edges.
      ctx.fillStyle = COLOR_COL_HOVER;
      if (axis === 'row') {
        ctx.fillRect(ox, oy + cursorLane * cs, gridW(), cs);
      } else {
        ctx.fillRect(ox + cursorLane * cs, oy, cs, gridH());
      }
    }

    for (let r = 0; r < gridRows(); r++) {
      for (let c = 0; c < gridCols(); c++) {
        ctx.fillStyle = COLOR_GRID_CELL;
        ctx.beginPath();
        ctx.roundRect(ox + c * cs + 2, oy + r * cs + 2, cs - 4, cs - 4, 6);
        ctx.fill();
      }
    }

    if (tutorial && axis === 'col') this.drawTutorialColumns(tutorial.allowedCols);
    if (tutorial && axis === 'row') this.drawTutorialRows(tutorial.allowedCols, entryEdge === 'right' ? 'right' : 'left');

    ctx.strokeStyle = COLOR_GRID_LINE;
    ctx.lineWidth = 1;
    for (let c = 0; c <= gridCols(); c++) {
      ctx.beginPath();
      ctx.moveTo(ox + c * cs, oy);
      ctx.lineTo(ox + c * cs, oy + gridH());
      ctx.stroke();
    }
    for (let r = 0; r <= gridRows(); r++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + r * cs);
      ctx.lineTo(ox + gridW(), oy + r * cs);
      ctx.stroke();
    }
  }

  // At a cardinal snap angle (0/90/180/270), clearing checks plain
  // rows/columns — the grid drawn above already IS that lattice, no overlay
  // needed. At a diagonal snap angle (45/135/225/315), clearing instead
  // checks runs along the two diagonals, but nothing about the plain
  // upright grid shows that — and a pile pressed against a wall naturally
  // looks like a straight column/row there regardless of the true gravity
  // angle, since walls are axis-aligned no matter which way gravity points.
  // Drawing the actual diagonal lattice makes the real check axis visible on
  // the board itself, the same way the ordinary grid already does for
  // cardinal angles. Uses the SNAPPED angle (matching whatever commit/preview
  // would actually settle+clear under), not the raw dragged angle, so this
  // updates live while aiming to show exactly what committing now would use.
  private drawDiagonalLanesIfActive(angleDeg: number): void {
    const snapped = snapAngleToEightDirections(angleDeg);
    if (snapped % 90 === 0) return; // cardinal — the plain grid already shows it
    this.drawDiagonalLattice();
  }

  private drawDiagonalLattice(): void {
    const { ctx } = this;
    const ox = gridOriginX();
    const oy = gridOriginY();
    const cs = cellSize();
    const cols = gridCols();
    const rows = gridRows();

    // Draws one straight segment from grid vertex (startRow,startCol) to
    // wherever stepping by (dRow,dCol) each cell first exits the grid —
    // vertex-aligned, so lines land exactly on cell boundaries like the
    // ordinary grid lines above.
    const drawLine = (startRow: number, startCol: number, dRow: 1, dCol: 1 | -1): void => {
      let endRow = startRow;
      let endCol = startCol;
      while (endRow + dRow >= 0 && endRow + dRow <= rows && endCol + dCol >= 0 && endCol + dCol <= cols) {
        endRow += dRow;
        endCol += dCol;
      }
      if (endRow === startRow && endCol === startCol) return; // zero-length, e.g. a corner
      ctx.beginPath();
      ctx.moveTo(ox + startCol * cs, oy + startRow * cs);
      ctx.lineTo(ox + endCol * cs, oy + endRow * cs);
      ctx.stroke();
    };

    ctx.save();
    ctx.strokeStyle = COLOR_GRAVITY_LANE;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);

    // "\" family (down-right / up-left diagonals, row-col=const): every
    // top-edge and left-edge vertex, stepping (+1,+1).
    for (let c = 0; c <= cols; c++) drawLine(0, c, 1, 1);
    for (let r = 1; r < rows; r++) drawLine(r, 0, 1, 1);

    // "/" family (down-left / up-right diagonals, row+col=const): every
    // top-edge and right-edge vertex, stepping (+1,-1).
    for (let c = 0; c <= cols; c++) drawLine(0, c, 1, -1);
    for (let r = 1; r < rows; r++) drawLine(r, cols, 1, -1);

    ctx.restore();
  }

  private drawTutorialColumns(allowedCols: readonly number[]): void {
    const { ctx } = this;
    const ox = gridOriginX();
    const oy = gridOriginY();
    const cs = cellSize();
    const top = oy + 1;
    const height = gridH() - 2;

    for (const col of allowedCols) {
      if (col < 0 || col >= gridCols()) continue;
      const x = ox + col * cs;

      const gradient = ctx.createLinearGradient(x, oy, x + cs, oy);
      gradient.addColorStop(0, 'rgba(46, 204, 113, 0.04)');
      gradient.addColorStop(0.5, 'rgba(46, 204, 113, 0.22)');
      gradient.addColorStop(1, 'rgba(46, 204, 113, 0.04)');

      ctx.save();
      ctx.fillStyle = gradient;
      ctx.fillRect(x + 1, top, cs - 2, height);

      ctx.strokeStyle = 'rgba(129, 230, 177, 0.72)';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 3, oy + 3, cs - 6, gridH() - 6);

      ctx.fillStyle = 'rgba(129, 230, 177, 0.95)';
      ctx.beginPath();
      ctx.arc(x + cs / 2, oy - 6, Math.max(3, Math.min(5, cs * 0.08)), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Mirrors drawTutorialColumns for a Gravity-mode tutorial step whose
  // gravity is tilted enough that lanes are ROWS (entry edge left/right) —
  // e.g. TutorialStep.gravityAngleDeg pre-tilting a step to 90deg. The entry
  // marker dot sits on whichever side discs actually enter from, matching
  // entryEdge, instead of always the left like the column version's always-top.
  private drawTutorialRows(allowedCols: readonly number[], entryEdge: 'left' | 'right'): void {
    const { ctx } = this;
    const ox = gridOriginX();
    const oy = gridOriginY();
    const cs = cellSize();
    const left = ox + 1;
    const width = gridW() - 2;
    const markerX = entryEdge === 'left' ? ox - 6 : ox + gridW() + 6;

    for (const row of allowedCols) {
      if (row < 0 || row >= gridRows()) continue;
      const y = oy + row * cs;

      const gradient = ctx.createLinearGradient(ox, y, ox, y + cs);
      gradient.addColorStop(0, 'rgba(46, 204, 113, 0.04)');
      gradient.addColorStop(0.5, 'rgba(46, 204, 113, 0.22)');
      gradient.addColorStop(1, 'rgba(46, 204, 113, 0.04)');

      ctx.save();
      ctx.fillStyle = gradient;
      ctx.fillRect(left, y + 1, width, cs - 2);

      ctx.strokeStyle = 'rgba(129, 230, 177, 0.72)';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + 3, y + 3, gridW() - 6, cs - 6);

      ctx.fillStyle = 'rgba(129, 230, 177, 0.95)';
      ctx.beginPath();
      ctx.arc(markerX, y + cs / 2, Math.max(3, Math.min(5, cs * 0.08)), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawStaticDiscs(board: Board, animations: readonly RichDiscAnimation[], animIds: Set<number>): void {
    // A top/bottom push only ever produces offsetY, left/right only ever
    // offsetX — see pushBoardOffsetX/Y — so applying both unconditionally is
    // always correct, not just for the vertical case Classic always used.
    const offsetX = pushBoardOffsetX(animations);
    const offsetY = pushBoardOffsetY(animations);
    for (let r = 0; r < board.length; r++) {
      for (let c = 0; c < board[r]!.length; c++) {
        const disc = board[r]![c];
        if (!disc || animIds.has(disc.id)) continue;
        this.drawDisc(disc, cellCenterX(c) + offsetX, cellCenterY(r) + offsetY, discR(), 1, 1);
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

  private drawScoreIndicators(indicators: readonly ScoreIndicator[]): void {
    const { ctx } = this;
    const cx = canvasLogicalWidth() / 2;
    const baseY = gridOriginY() + gridH() * 0.42;
    indicators.forEach((indicator, index) => {
      const y = baseY + index * 58;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, indicator.alpha));
      ctx.translate(cx, y);
      ctx.scale(indicator.scale, indicator.scale);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,0.85)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = COLOR_SCORE_POPUP;
      ctx.font = 'bold 25px system-ui, sans-serif';
      ctx.fillText(indicator.title, 0, -12);
      ctx.fillStyle = COLOR_TEXT;
      ctx.font = 'bold 16px system-ui, sans-serif';
      ctx.fillText(indicator.detail, 0, 15);
      ctx.restore();
    });
  }

  // Gravity mode: previewLanding is the TRUE predicted resting cell (computed
  // by the caller via GameEngine.previewDropLanding, which actually runs the
  // settle), not just the entry edge — so the ghost shows exactly where a
  // drop would end up, same as Classic's straight-down ghost does.
  private drawGhostGravity(state: GameState, previewLanding: GridPos | null): void {
    if (!previewLanding) return; // lane full, or nothing to preview
    const gravity = state.gravity!;
    const entryEdge = entryEdgeForAngle(gravity.angle);
    const off = offBoardEntryPosition(entryEdge, state.cursorCol, gridRows(), gridCols());
    const cx = cellCenterX(previewLanding.col);
    const cy = cellCenterY(previewLanding.row);
    this.drawDisc(state.currentDisc, cx, cy, discR(), 0.32, 1);

    const { ctx } = this;
    ctx.strokeStyle = COLOR_GHOST;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(cellCenterX(off.col), cellCenterY(off.row));
    ctx.lineTo(cx, cy);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawGhost(state: GameState, board: Board, previewLanding: GridPos | null): void {
    if (state.gravity) { this.drawGhostGravity(state, previewLanding); return; }

    const cursorCol = state.cursorCol;
    // Reproduce the same bottom-up scan as landingRow() to show where the
    // current disc would actually land if the player drops here.
    let landRow = -1;
    for (let r = board.length - 1; r >= 0; r--) {
      if (board[r]![cursorCol] === null) { landRow = r; break; }
    }
    if (landRow < 0) return; // column full — no ghost

    const cx = cellCenterX(cursorCol);
    const cy = cellCenterY(landRow);
    this.drawDisc(state.currentDisc, cx, cy, discR(), 0.28, 1);

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


  private drawHUD(
    state: GameState,
    displayScore: number,
    initialTurnsPerLevel: number,
    levelProgress: LevelProgressDisplay,
  ): void {
    const { ctx } = this;
    const lw = canvasLogicalWidth();
    const gp = gridPadding();

    // Score — centered across the top of the canvas.
    ctx.fillStyle = COLOR_TEXT;
    ctx.font = 'bold 24px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayScore.toLocaleString('en-US'), lw / 2, HUD_TOP_HEIGHT * 0.25);

    // Turn pips — one circle per turn in the current level, filled while unused.
    // A push happens the instant these run out, so this line doubles as the
    // push countdown — no separate readout needed.
    this.drawTurnPips(
      levelProgress.turnsRemaining,
      levelProgress.turnsPerLevel,
      initialTurnsPerLevel,
      HUD_TOP_HEIGHT * 0.6,
    );

    // Level, directly below the turn pips.
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillStyle = COLOR_TEXT_DIM;
    ctx.textAlign = 'center';
    ctx.fillText(`LVL ${levelProgress.level}`, lw / 2, HUD_TOP_HEIGHT * 0.88);

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
    const aiming = state.phase === GamePhase.Aiming;
    const hint = isTouchDevice()
      ? (aiming ? 'Q/E adjust (keyboard needed to tilt)' : state.gravity ? 'tap lane to drop' : 'tap column to drop')
      : aiming
        ? 'Q/E adjust  ↓ / Enter confirm  Esc cancel'
        : (state.gravity
          ? '← → move  ↓ drop  Q/E tilt  R restart'
          : '← → move  ↓ / click drop  R restart');
    ctx.fillText(hint, lw - gp, hudCy + 8);
  }

  // Compact always-visible indicator of the current gravity direction. During
  // Aiming, also draws a faint arc showing how far the player may still tilt
  // from the turn's starting angle.
  private drawGravityCompass(state: GameState, cx: number, cy: number): void {
    const gravity = state.gravity;
    if (!gravity) return;
    const { ctx } = this;
    const radius = 26;

    // Opaque backdrop so the dial reads clearly against the score/board
    // behind it instead of blending into whatever's underneath.
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
    ctx.fill();
    ctx.strokeStyle = COLOR_GRAVITY_ACCENT;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (state.phase === GamePhase.Aiming) {
      const a1 = canvasAngleRad(gravity.turnStartAngle - gravity.maxTiltDelta);
      const a2 = canvasAngleRad(gravity.turnStartAngle + gravity.maxTiltDelta);
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = COLOR_GRAVITY_ACCENT;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 12, Math.min(a1, a2), Math.max(a1, a2));
      ctx.stroke();
      ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = COLOR_TEXT_DIM;
    ctx.lineWidth = 1;
    ctx.stroke();

    const { gx, gy } = computeGravityVector(gravity.angle);
    const tipX = cx + gx * radius * 0.82;
    const tipY = cy + gy * radius * 0.82;
    ctx.strokeStyle = COLOR_GRAVITY_ACCENT;
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    const headAngle = Math.atan2(gy, gx);
    const headLen = 9;
    ctx.fillStyle = COLOR_GRAVITY_ACCENT;
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - headLen * Math.cos(headAngle - Math.PI / 6), tipY - headLen * Math.sin(headAngle - Math.PI / 6));
    ctx.lineTo(tipX - headLen * Math.cos(headAngle + Math.PI / 6), tipY - headLen * Math.sin(headAngle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
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
    ctx.fillText(`High ${stats.highScore.toLocaleString('en-US')}   •   Longest chain ${stats.longestStreak.toLocaleString('en-US')}`, lw / 2, lh / 2 + 8);
    ctx.fillText(`Average ${stats.averageScore.toLocaleString('en-US')} over ${stats.gamesPlayed.toLocaleString('en-US')} game${stats.gamesPlayed === 1 ? '' : 's'}`, lw / 2, lh / 2 + 30);

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
