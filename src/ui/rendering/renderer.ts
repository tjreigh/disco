import type { Board, Disc, EntryEdge, GridPos } from '../../game/model.js';
import { DiscKind } from '../../game/model.js';
import type { GameState, GravityState } from '../../game/state.js';
import { GamePhase } from '../../game/state.js';
import {
  computeGravityVector, entryEdgeForAngle,
  offBoardEntryPosition, snapAngleToEightDirections,
} from '../../game/gravity/settling.js';
import type { GravityShiftCue, RichDiscAnimation, ScoreIndicator, ScorePopup } from './animation-types.js';
import {
  DISC_COLORS,
  COLOR_BG, COLOR_GRID_CELL, COLOR_GRID_LINE,
  COLOR_CRACKED_FILL, COLOR_CRACKED_DARK, COLOR_CRACK_LINE,
  COLOR_TEXT, COLOR_TEXT_DIM, COLOR_GHOST, COLOR_COL_HOVER,
  COLOR_GAMEOVER_BG, COLOR_SCORE_POPUP, COLOR_GRAVITY_LANE,
  COLOR_OPPONENT_GHOST,
} from './theme.js';
import {
  cellCenterX, cellCenterY, gridOriginX, gridOriginY,
  canvasLogicalWidth, canvasLogicalHeight, gridW, gridH,
  cellSize, updateCellSize, gridCols, gridRows,
} from './layout.js';
import { interpolateY, interpolateX, pushBoardOffsetX, pushBoardOffsetY } from './animation-queue.js';
import type { GameStats } from '../../game/stats.js';
import { isTouchDevice, prefersReducedMotion } from '../dom-utils.js';

export interface TutorialVisualState {
  allowedCols: readonly number[];
  /** A lane is staged (phase === Aiming) — the highlight renders in the blue gravity accent. */
  staged: boolean;
  /** No committable tilt exists yet — the highlight pulses and shows ↺/↻ arrows. Distinct from `staged`: after a valid tilt the lane stays blue but goes steady and loses the arrows, since the remaining action is Confirm. */
  needsTilt: boolean;
}

export interface RewindVisualState {
  targets: ReadonlyArray<{
    position: GridPos;
    resultingKind: DiscKind.SingleCracked | DiscKind.DoubleCracked;
  }>;
}

// Computed each draw call so it stays proportional after a resize.
function discR(): number { return cellSize() / 2 - Math.max(3, cellSize() * 0.07); }

// While a lane is staged (Aiming, pendingLane set), the entry edge a drop
// will actually use is pinned to turnStartAngle — tilting only reshapes how
// the board settles, not which edge the disc entered from (see engine.ts
// commitTilt/previewDropLanding, both of which read turnStartAngle here).
// Grid-lane rendering (which axis is "columns" vs "rows", and the tutorial
// highlight/marker built on it) must track that same pinned edge instead of
// the live drag angle — otherwise crossing a 45deg boundary mid-tilt flips
// the highlighted lane from a column to a row (or back) even though the
// staged lane hasn't moved, which reads as the highlight jumping to a
// different, unrelated part of the board.
function pinnedGravityAngle(gravity: GravityState | undefined): number | undefined {
  if (!gravity) return undefined;
  return gravity.pendingLane !== undefined ? gravity.turnStartAngle : gravity.angle;
}

// Row cursor/lanes when gravity currently enters from the side, column
// cursor/lanes otherwise (Classic, or Gravity mode pointing mostly up/down).
function axisForGravity(gravity: GravityState | undefined): 'col' | 'row' {
  const angle = pinnedGravityAngle(gravity);
  if (angle === undefined) return 'col';
  const entryEdge = entryEdgeForAngle(angle);
  return entryEdge === 'left' || entryEdge === 'right' ? 'row' : 'col';
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
    const stage = this.canvas.parentElement;
    const bounds = stage?.getBoundingClientRect();
    const stageBounds = bounds && bounds.width > 0 && bounds.height > 0
      ? { width: bounds.width, height: bounds.height }
      : undefined;
    updateCellSize(stageBounds);
    this.dpr = window.devicePixelRatio || 1;
    const lw = canvasLogicalWidth();
    const lh = canvasLogicalHeight();
    // Set the backing-store size in physical pixels.
    this.canvas.width  = Math.round(lw * this.dpr);
    this.canvas.height = Math.round(lh * this.dpr);
    // CSS size stays at logical pixels so the canvas looks the right size on screen.
    this.canvas.style.width  = `${lw}px`;
    this.canvas.style.height = `${lh}px`;
    stage?.style.setProperty('--game-canvas-width', `${lw}px`);
    stage?.style.setProperty('--game-canvas-height', `${lh}px`);
    stage?.style.setProperty('--game-grid-width', `${gridW()}px`);
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
    scorePopups: readonly ScorePopup[],
    scoreIndicators: readonly ScoreIndicator[],
    tutorial?: TutorialVisualState | null,
    previewLanding?: GridPos | null,
    isStackMode = false,
    gravityShiftCue?: GravityShiftCue | null,
    rewind?: RewindVisualState | null,
    opponentCursor?: { col: number; disc: Disc } | null,
  ): void {
    const { ctx } = this;
    // Build a set of disc IDs currently being animated. drawStaticDiscs uses
    // this to skip those cells — without it a disc would be drawn twice: once
    // at its board position and once at its interpolated animation position.
    const animIds = new Set(animations.map(a => a.discId));

    ctx.clearRect(0, 0, canvasLogicalWidth(), canvasLogicalHeight());
    this.drawBackground();
    if (state.phase === GamePhase.Menu) return; // DOM overlay owns the screen entirely
    if (state.gravity) this.drawGravityAmbient(state.gravity, gravityShiftCue ?? null);
    const showCursor = state.phase === GamePhase.WaitingForDrop;
    const axis = axisForGravity(state.gravity);
    const pinnedAngle = pinnedGravityAngle(state.gravity);
    const entryEdge = pinnedAngle !== undefined ? entryEdgeForAngle(pinnedAngle) : null;
    // Tutorial lanes are interaction targets, not persistent board markings.
    // Once a turn is accepted, hiding the lane throughout resolution avoids
    // reverting the staged blue cue to green and rotating it with the newly
    // committed gravity axis while discs animate. The next tutorial step will
    // naturally provide its own green target after resolution completes.
    const interactiveTutorial = state.phase === GamePhase.Animating ? null : tutorial ?? null;
    this.drawGrid(state.cursorCol, showCursor, axis, interactiveTutorial, entryEdge);
    if (state.gravity) this.drawDiagonalLanesIfActive(state.gravity.angle);
    // During Aiming, `board` is already the live settle preview (the caller
    // substitutes it) — drawn through the same static-disc path as any other
    // committed board, no separate staged-disc rendering needed.
    this.drawStaticDiscs(board, animations, animIds, rewind ?? null);
    this.drawAnimatedDiscs(animations);
    if (rewind) this.drawPendingFractures(rewind);
    // The shift-cue's edge glow draws on top of the board so the pulse is
    // visible while discs are still animating into their post-tilt positions.
    if (gravityShiftCue) this.drawGravityShiftGlow(gravityShiftCue);
    this.drawScorePopups(scorePopups);
    this.drawScoreIndicators(scoreIndicators);
    if (showCursor) {
      this.drawGhost(state, board, previewLanding ?? null);
    }
    if (opponentCursor) {
      this.drawOpponentGhost(opponentCursor.disc, opponentCursor.col, board);
    }
    if (state.phase === GamePhase.GameOver) {
      this.drawGameOver(state.score, stats, isStackMode);
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
  // While a shift cue is active, the wash sweeps along the cue's eased
  // interpolated angle (not the already-committed value) and its accent stop
  // brightens with the cue's sine-pulse alpha, so the rotation reads as a
  // distinct, visible event instead of snapping invisibly on the first
  // post-commit frame.
  private drawGravityAmbient(gravity: GravityState, cue: GravityShiftCue | null = null): void {
    const { ctx } = this;
    const { gx, gy } = computeGravityVector(cue ? cue.angle : gravity.angle);
    const cx = gridOriginX() + gridW() / 2;
    const cy = gridOriginY() + gridH() / 2;
    const radius = Math.max(gridW(), gridH()) * 0.8;
    const gradient = ctx.createLinearGradient(cx - gx * radius, cy - gy * radius, cx + gx * radius, cy + gy * radius);
    // rgba form of COLOR_GRAVITY_ACCENT (#62b0e8) — canvas gradients need
    // per-stop alpha, which a hex constant alone can't express. The cue boosts
    // the accent stop on top of the resting wash so the pulse stands out.
    const resting = 0.20;
    const intensity = cue ? resting + cue.alpha * 0.30 : resting;
    gradient.addColorStop(0, 'rgba(98, 176, 232, 0)');
    gradient.addColorStop(0.6, 'rgba(98, 176, 232, 0)');
    gradient.addColorStop(1, `rgba(98, 176, 232, ${intensity})`);
    ctx.save();
    ctx.fillStyle = gradient;
    ctx.fillRect(gridOriginX(), gridOriginY(), gridW(), gridH());
    ctx.restore();
  }

  // The secondary highlight the player sees while a tilt's cue is active: a
  // thin pulsing bar hugging the NEW entry edge (where the recentered cursor
  // highlight will land once the turn resolves — see engine.commitTilt's
  // axis-aware recenter), alpha-tied to the cue's sine pulse. Reuses
  // COLOR_GRAVITY_ACCENT (rgba form) so it reads as part of the same gravity
  // language, distinct from the tutorial's green lane highlight.
  private drawGravityShiftGlow(cue: GravityShiftCue): void {
    const { ctx } = this;
    const edge = entryEdgeForAngle(cue.toAngle);
    const ox = gridOriginX();
    const oy = gridOriginY();
    const w = gridW();
    const h = gridH();
    const thickness = Math.max(4, cellSize() * 0.12);
    let x: number, y: number, rw: number, rh: number;
    if (edge === 'top') { x = ox; y = oy; rw = w; rh = thickness; }
    else if (edge === 'bottom') { x = ox; y = oy + h - thickness; rw = w; rh = thickness; }
    else if (edge === 'left') { x = ox; y = oy; rw = thickness; rh = h; }
    else { x = ox + w - thickness; y = oy; rw = thickness; rh = h; } // right
    ctx.save();
    ctx.fillStyle = `rgba(98, 176, 232, ${cue.alpha * 0.75})`;
    ctx.fillRect(x, y, rw, rh);
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

    if (tutorial && axis === 'col') this.drawTutorialColumns(tutorial, entryEdge === 'bottom' ? 'bottom' : 'top');
    if (tutorial && axis === 'row') this.drawTutorialRows(tutorial, entryEdge === 'right' ? 'right' : 'left');

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

  // Shared palette for the tutorial lane highlight's two states: green while
  // the player is choosing a lane, blue gravity accent once one is staged.
  // While a tilt is still owed (needsTilt) the blue variant pulses at ~2 Hz
  // and gains ↺/↻ arrow glyphs; after a committable tilt exists it goes
  // steady and loses the arrows — the remaining action is Confirm, not more
  // tilting. Reduced motion swaps the pulse for a fixed mid-bright alpha.
  private tutorialLanePalette(tutorial: TutorialVisualState) {
    const { staged, needsTilt } = tutorial;
    const pulse = needsTilt && !prefersReducedMotion()
      ? Math.sin(performance.now() / 1000 * Math.PI * 4) * 0.5 + 0.5
      : needsTilt ? 0.7 : 0;
    const laneRGB   = staged ? '98, 176, 232'  : '46, 204, 113';
    const brightRGB = staged ? '146, 199, 240' : '129, 230, 177';
    const midAlpha    = needsTilt ? 0.16 + 0.24 * pulse : 0.22;
    const borderAlpha = needsTilt ? 0.50 + 0.35 * pulse : 0.72;
    const arrowAlpha  = 0.55 + 0.40 * pulse;
    return { laneRGB, brightRGB, midAlpha, borderAlpha, arrowAlpha, needsTilt };
  }

  private drawTutorialArrows(cwX: number, cwY: number, ccwX: number, ccwY: number, brightRGB: string, arrowAlpha: number): void {
    const { ctx } = this;
    const fontPx = Math.max(12, Math.round(cellSize() * 0.24));
    ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = `rgba(${brightRGB}, ${arrowAlpha.toFixed(3)})`;
    ctx.fillText('↺', ccwX, ccwY);
    ctx.fillText('↻', cwX, cwY);
  }

  private drawTutorialColumns(tutorial: TutorialVisualState, entryEdge: 'top' | 'bottom'): void {
    // The highlighted lane is an input target, not a gravity-direction
    // indicator. Once a committable rotation exists, hiding it prevents the
    // pinned entry lane from looking stale while the settled preview moves.
    if (tutorial.staged && !tutorial.needsTilt) return;
    const { ctx } = this;
    const ox = gridOriginX();
    const oy = gridOriginY();
    const cs = cellSize();
    const top = oy + 1;
    const height = gridH() - 2;
    const { laneRGB, brightRGB, midAlpha, borderAlpha, arrowAlpha, needsTilt } = this.tutorialLanePalette(tutorial);
    // Marker and arrows sit in the half-cell entry pad on whichever edge
    // discs actually enter from (layout's ENTRY_PAD_CELLS guarantees room).
    const markerY = entryEdge === 'top' ? oy - 6 : oy + gridH() + 6;
    const arrowY = entryEdge === 'top'
      ? oy - Math.max(9, cs * 0.15)
      : oy + gridH() + Math.max(9, cs * 0.15);

    for (const col of tutorial.allowedCols) {
      if (col < 0 || col >= gridCols()) continue;
      const x = ox + col * cs;

      const gradient = ctx.createLinearGradient(x, oy, x + cs, oy);
      gradient.addColorStop(0, `rgba(${laneRGB}, 0.04)`);
      gradient.addColorStop(0.5, `rgba(${laneRGB}, ${midAlpha.toFixed(3)})`);
      gradient.addColorStop(1, `rgba(${laneRGB}, 0.04)`);

      ctx.save();
      ctx.fillStyle = gradient;
      ctx.fillRect(x + 1, top, cs - 2, height);

      ctx.strokeStyle = `rgba(${brightRGB}, ${borderAlpha.toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 3, oy + 3, cs - 6, gridH() - 6);

      ctx.fillStyle = `rgba(${brightRGB}, 0.95)`;
      ctx.beginPath();
      ctx.arc(x + cs / 2, markerY, Math.max(3, Math.min(5, cs * 0.08)), 0, Math.PI * 2);
      ctx.fill();
      if (needsTilt) {
        this.drawTutorialArrows(x + cs / 2 + cs * 0.45, arrowY, x + cs / 2 - cs * 0.45, arrowY, brightRGB, arrowAlpha);
      }
      ctx.restore();
    }
  }

  // Mirrors drawTutorialColumns for a Gravity-mode tutorial step whose
  // gravity is tilted enough that lanes are ROWS (entry edge left/right) —
  // e.g. TutorialStep.gravityAngleDeg pre-tilting a step to 90deg. The entry
  // marker dot and the ↺/↻ arrows sit on whichever side discs actually enter
  // from, matching entryEdge.
  private drawTutorialRows(tutorial: TutorialVisualState, entryEdge: 'left' | 'right'): void {
    if (tutorial.staged && !tutorial.needsTilt) return;
    const { ctx } = this;
    const ox = gridOriginX();
    const oy = gridOriginY();
    const cs = cellSize();
    const left = ox + 1;
    const width = gridW() - 2;
    const { laneRGB, brightRGB, midAlpha, borderAlpha, arrowAlpha, needsTilt } = this.tutorialLanePalette(tutorial);
    const markerX = entryEdge === 'left' ? ox - 6 : ox + gridW() + 6;
    const arrowX = entryEdge === 'left'
      ? ox - Math.max(9, cs * 0.15)
      : ox + gridW() + Math.max(9, cs * 0.15);

    for (const row of tutorial.allowedCols) {
      if (row < 0 || row >= gridRows()) continue;
      const y = oy + row * cs;

      const gradient = ctx.createLinearGradient(ox, y, ox, y + cs);
      gradient.addColorStop(0, `rgba(${laneRGB}, 0.04)`);
      gradient.addColorStop(0.5, `rgba(${laneRGB}, ${midAlpha.toFixed(3)})`);
      gradient.addColorStop(1, `rgba(${laneRGB}, 0.04)`);

      ctx.save();
      ctx.fillStyle = gradient;
      ctx.fillRect(left, y + 1, width, cs - 2);

      ctx.strokeStyle = `rgba(${brightRGB}, ${borderAlpha.toFixed(3)})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + 3, y + 3, gridW() - 6, cs - 6);

      ctx.fillStyle = `rgba(${brightRGB}, 0.95)`;
      ctx.beginPath();
      ctx.arc(markerX, y + cs / 2, Math.max(3, Math.min(5, cs * 0.08)), 0, Math.PI * 2);
      ctx.fill();
      if (needsTilt) {
        this.drawTutorialArrows(arrowX, y + cs / 2 + cs * 0.45, arrowX, y + cs / 2 - cs * 0.45, brightRGB, arrowAlpha);
      }
      ctx.restore();
    }
  }

  private drawStaticDiscs(
    board: Board,
    animations: readonly RichDiscAnimation[],
    animIds: Set<number>,
    rewind: RewindVisualState | null,
  ): void {
    // A top/bottom push only ever produces offsetY, left/right only ever
    // offsetX — see pushBoardOffsetX/Y — so applying both unconditionally is
    // always correct, not just for the vertical case Classic always used.
    const offsetX = pushBoardOffsetX(animations);
    const offsetY = pushBoardOffsetY(animations);
    const targets = new Set(rewind?.targets.map(target => `${target.position.row}:${target.position.col}`) ?? []);
    for (let r = 0; r < board.length; r++) {
      for (let c = 0; c < board[r]!.length; c++) {
        const disc = board[r]![c];
        if (!disc || animIds.has(disc.id)) continue;
        const alpha = rewind && !targets.has(`${r}:${c}`) ? 0.48 : 1;
        this.drawDisc(disc, cellCenterX(c) + offsetX, cellCenterY(r) + offsetY, discR(), alpha, 1);
      }
    }
  }

  private drawPendingFractures(rewind: RewindVisualState): void {
    const { ctx } = this;
    const radius = discR();
    for (const target of rewind.targets) {
      const cx = cellCenterX(target.position.col);
      const cy = cellCenterY(target.position.row);
      const double = target.resultingKind === DiscKind.DoubleCracked;

      ctx.save();
      ctx.translate(cx, cy);

      // A bright cell-scale halo keeps the target legible even in a crowded
      // board without replacing the numbered disc the player needs to identify.
      ctx.shadowColor = '#e879f9';
      ctx.shadowBlur = Math.max(14, radius * 0.5);
      ctx.strokeStyle = '#e879f9';
      ctx.lineWidth = Math.max(3, radius * 0.1);
      ctx.beginPath();
      ctx.arc(0, 0, radius + Math.max(6, radius * 0.18), 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.strokeStyle = '#67e8f9';
      ctx.lineWidth = Math.max(2, radius * 0.065);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-radius * 0.22, -radius * 0.62);
      ctx.lineTo(-radius * 0.04, -radius * 0.12);
      ctx.lineTo(radius * 0.3, radius * 0.62);
      ctx.stroke();
      if (double) {
        ctx.beginPath();
        ctx.moveTo(radius * 0.4, -radius * 0.54);
        ctx.lineTo(radius * 0.08, -radius * 0.08);
        ctx.lineTo(-radius * 0.36, radius * 0.56);
        ctx.stroke();
      }

      const badgeRadius = Math.max(8, radius * 0.25);
      const badgeX = radius * 0.82;
      const badgeY = -radius * 0.82;
      ctx.fillStyle = '#e879f9';
      ctx.beginPath();
      ctx.arc(badgeX, badgeY, badgeRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1027';
      ctx.font = `900 ${Math.round(badgeRadius * 1.35)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', badgeX, badgeY + 0.5);
      ctx.restore();
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

  // Disco Duel only: the opponent's live column selection while it's their
  // turn, so both players see the same preview a local ghost would show.
  // Deliberately independent of drawGhost's gravity branch — Disco Duel has
  // no gravity mode, so this only ever needs the straight-down scan.
  private drawOpponentGhost(disc: Disc, col: number, board: Board): void {
    let landRow = -1;
    for (let r = board.length - 1; r >= 0; r--) {
      if (board[r]![col] === null) { landRow = r; break; }
    }
    if (landRow < 0) return; // column full — no ghost

    const cx = cellCenterX(col);
    const cy = cellCenterY(landRow);
    this.drawDisc(disc, cx, cy, discR(), 0.28, 1);

    const { ctx } = this;
    ctx.strokeStyle = COLOR_OPPONENT_GHOST;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(cx, gridOriginY());
    ctx.lineTo(cx, cy - discR() - 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  private drawGameOver(score: number, stats: GameStats, isStackMode: boolean): void {
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
    const recordLabel = isStackMode ? 'Best turn' : 'Best chain';
    const recordValue = isStackMode
      ? `${stats.longestStreak.toLocaleString('en-US')} cleared`
      : `${stats.longestStreak.toLocaleString('en-US')} wave${stats.longestStreak === 1 ? '' : 's'}`;
    ctx.fillText(`High ${stats.highScore.toLocaleString('en-US')}   •   ${recordLabel} ${recordValue}`, lw / 2, lh / 2 + 8);
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
      if (disc.temporalFracture) drawTemporalFracture(ctx, r);
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

function drawTemporalFracture(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.save();
  ctx.lineWidth = Math.max(1.5, r * 0.07);
  ctx.lineCap = 'round';
  ctx.setLineDash([r * 0.18, r * 0.12]);
  ctx.strokeStyle = '#22d3ee';
  ctx.beginPath();
  ctx.arc(-r * 0.05, 0, r * 0.82, -Math.PI * 0.72, Math.PI * 0.18);
  ctx.stroke();
  ctx.strokeStyle = '#e879f9';
  ctx.beginPath();
  ctx.arc(r * 0.05, 0, r * 0.9, Math.PI * 0.28, Math.PI * 1.14);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// Adds a fixed amount of brightness to each RGB channel of a 6-digit hex color.
function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, ((n >> 16) & 0xff) + Math.round(255 * amount));
  const g = Math.min(255, ((n >> 8)  & 0xff) + Math.round(255 * amount));
  const b = Math.min(255, ( n        & 0xff) + Math.round(255 * amount));
  return `rgb(${r},${g},${b})`;
}
