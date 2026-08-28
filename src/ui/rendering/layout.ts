import { MAX_CELL_SIZE, MIN_CELL_SIZE, HUD_TOP_HEIGHT, HUD_BOTTOM_HEIGHT } from './theme.js';

// Vertical bands reserved by the original canvas composition. The renderer no
// longer paints HUD pixels, but retaining these bands keeps the DOM overlay and
// board proportions aligned with the original game.
const GRID_PAD_V = 8;
// Drops and pushes animate from one cell outside the board on every edge.
// A half-cell lane restores the side/top/bottom breathing room without giving
// up a full playable cell's worth of mobile board space.
const ENTRY_PAD_CELLS = 0.5;
export const DEFAULT_BOARD_COLS = 7;
export const DEFAULT_BOARD_ROWS = 7;

// Module-level geometry, updated by updateCellSize() on every resize. All
// geometry functions read from this so a single resize call propagates everywhere.
let _cellSize = MAX_CELL_SIZE;
let _gridCols = DEFAULT_BOARD_COLS;
let _gridRows = DEFAULT_BOARD_ROWS;
let _layoutWidth = 0;
let _layoutHeight = 0;
let _hudTopHeight = HUD_TOP_HEIGHT;
let _hudBottomHeight = HUD_BOTTOM_HEIGHT;

export interface LayoutBounds {
  width: number;
  height: number;
}

export function setGridSize(cols: number, rows: number): void {
  _gridCols = Math.max(1, Math.floor(cols));
  _gridRows = Math.max(1, Math.floor(rows));
}

/** Removes the full game's HUD bands for chrome-free render targets such as embeds. */
export function setHudBands(top: number = HUD_TOP_HEIGHT, bottom: number = HUD_BOTTOM_HEIGHT): void {
  _hudTopHeight = Math.max(0, top);
  _hudBottomHeight = Math.max(0, bottom);
}

export function gridCols(): number {
  return _gridCols;
}

export function gridRows(): number {
  return _gridRows;
}

/**
 * Recomputes the cell size to fit the game stage.
 *
 * @remarks
 * The viewport fallback keeps layout helpers usable before the DOM shell exists
 * and in isolated tests.
 */
export function updateCellSize(bounds?: LayoutBounds): void {
  _layoutWidth = Math.max(0, bounds?.width ?? window.innerWidth);
  _layoutHeight = Math.max(0, bounds?.height ?? window.innerHeight);
  const availW = _layoutWidth;
  const availH = _layoutHeight - _hudTopHeight - _hudBottomHeight - GRID_PAD_V * 2;
  const byWidth  = Math.floor(availW / (gridCols() + ENTRY_PAD_CELLS * 2));
  const byHeight = Math.floor(availH / (gridRows() + ENTRY_PAD_CELLS * 2));
  _cellSize = Math.max(MIN_CELL_SIZE, Math.min(MAX_CELL_SIZE, byWidth, byHeight));
}

export function cellSize(): number { return _cellSize; }

/**
 * Horizontal padding that centers the grid within the stage.
 *
 * @remarks
 * Keeps the real remainder (including values below 8px) so the canvas can't
 * exceed a narrow stage.
 */
export function gridPadding(): number {
  return Math.max(0, Math.floor((_layoutWidth - _cellSize * (gridCols() + ENTRY_PAD_CELLS * 2)) / 2));
}

export function gridW(): number { return _cellSize * gridCols(); }
export function gridH(): number { return _cellSize * gridRows(); }

export function gridOriginX(): number { return gridPadding() + _cellSize * ENTRY_PAD_CELLS; }
export function gridOriginY(): number { return _hudTopHeight + GRID_PAD_V + _cellSize * ENTRY_PAD_CELLS; }

export function canvasLogicalWidth(): number  {
  return gridW() + (gridPadding() + _cellSize * ENTRY_PAD_CELLS) * 2;
}
export function canvasLogicalHeight(): number {
  return _hudTopHeight + gridH() + (_cellSize * ENTRY_PAD_CELLS + GRID_PAD_V) * 2 + _hudBottomHeight;
}

/**
 * Canvas pixel X coordinate of the center of grid column `col`.
 *
 * @remarks
 * The paired {@link cellCenterY} accepts negative rows: row -1 sits one
 * cell-height above the grid and is the drop animation's starting Y.
 */
export function cellCenterX(col: number): number {
  return gridOriginX() + col * _cellSize + _cellSize / 2;
}

export function cellCenterY(row: number): number {
  return gridOriginY() + row * _cellSize + _cellSize / 2;
}

/** Directional alias for {@link cellCenterY}, kept for call-site clarity. */
export function cellCenterYFromTop(row: number): number { return cellCenterY(row); }
export function cellCenterXFromLeft(col: number): number { return cellCenterX(col); }

/** Converts a client X coordinate to a grid column index, or `null` if outside the grid. */
export function pixelToCol(canvasRect: DOMRect, clientX: number): number | null {
  // Derive the rendered cell width from the rect rather than using _cellSize
  // directly, in case CSS scaling is ever applied to the canvas element.
  const renderedGridW = canvasRect.width * (gridW() / canvasLogicalWidth());
  const renderedOriginX = canvasRect.width * (gridOriginX() / canvasLogicalWidth());
  const x = clientX - canvasRect.left - renderedOriginX;
  const renderedCell = renderedGridW / gridCols();
  const col = Math.floor(x / renderedCell);
  return col >= 0 && col < gridCols() ? col : null;
}

/**
 * Converts a client Y coordinate to a grid row index, or `null` if outside the
 * grid.
 *
 * @remarks
 * Mirrors {@link pixelToCol} — needed for lane selection when Gravity mode's
 * entry edge is left or right (lanes are rows, not columns).
 */
export function pixelToRow(canvasRect: DOMRect, clientY: number): number | null {
  const renderedGridH = canvasRect.height * (gridH() / canvasLogicalHeight());
  const renderedOriginY = canvasRect.height * (gridOriginY() / canvasLogicalHeight());
  const y = clientY - canvasRect.top - renderedOriginY;
  const renderedCell = renderedGridH / gridRows();
  const row = Math.floor(y / renderedCell);
  return row >= 0 && row < gridRows() ? row : null;
}
