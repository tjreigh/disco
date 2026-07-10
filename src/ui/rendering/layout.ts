import { MAX_CELL_SIZE, MIN_CELL_SIZE, HUD_TOP_HEIGHT, HUD_BOTTOM_HEIGHT } from './theme.js';

// Vertical gap above and below the grid within the canvas (fixed — only
// horizontal padding is dynamic).
const GRID_PAD_V = 8;
export const DEFAULT_BOARD_COLS = 7;
export const DEFAULT_BOARD_ROWS = 7;

// Module-level geometry, updated by updateCellSize() on every resize. All
// geometry functions read from this so a single resize call propagates everywhere.
let _cellSize = MAX_CELL_SIZE;
let _gridCols = DEFAULT_BOARD_COLS;
let _gridRows = DEFAULT_BOARD_ROWS;
let _layoutWidth = 0;
let _layoutHeight = 0;

export interface LayoutBounds {
  width: number;
  height: number;
}

export function setGridSize(cols: number, rows: number): void {
  _gridCols = Math.max(1, Math.floor(cols));
  _gridRows = Math.max(1, Math.floor(rows));
}

export function gridCols(): number {
  return _gridCols;
}

export function gridRows(): number {
  return _gridRows;
}

// Recomputes the cell size to fit the game stage. The viewport fallback keeps
// layout helpers usable before the DOM shell exists and in isolated tests.
export function updateCellSize(bounds?: LayoutBounds): void {
  _layoutWidth = Math.max(0, bounds?.width ?? window.innerWidth);
  _layoutHeight = Math.max(0, bounds?.height ?? window.innerHeight);
  const availW = _layoutWidth;
  const availH = _layoutHeight - HUD_TOP_HEIGHT - HUD_BOTTOM_HEIGHT - GRID_PAD_V * 2;
  const byWidth  = Math.floor(availW / gridCols());
  const byHeight = Math.floor(availH / gridRows());
  _cellSize = Math.max(MIN_CELL_SIZE, Math.min(MAX_CELL_SIZE, byWidth, byHeight));
}

export function cellSize(): number { return _cellSize; }

// Centers the grid horizontally within the stage. Keeping the real remainder
// (including values below 8px) prevents the canvas from exceeding a narrow stage.
export function gridPadding(): number {
  return Math.max(0, Math.floor((_layoutWidth - _cellSize * gridCols()) / 2));
}

export function gridW(): number { return _cellSize * gridCols(); }
export function gridH(): number { return _cellSize * gridRows(); }

export function gridOriginX(): number { return gridPadding(); }
export function gridOriginY(): number { return HUD_TOP_HEIGHT + GRID_PAD_V; }

export function canvasLogicalWidth(): number  { return gridW() + gridPadding() * 2; }
export function canvasLogicalHeight(): number {
  return HUD_TOP_HEIGHT + gridH() + GRID_PAD_V * 2 + HUD_BOTTOM_HEIGHT;
}

// Returns the canvas pixel coordinate of the center of a grid cell.
// Negative row values are valid: row -1 is one cell-height above the grid,
// used as the starting Y position for the drop animation.
export function cellCenterX(col: number): number {
  return gridOriginX() + col * _cellSize + _cellSize / 2;
}

export function cellCenterY(row: number): number {
  return gridOriginY() + row * _cellSize + _cellSize / 2;
}

// Aliases kept for call-site clarity; both delegate to the functions above.
export function cellCenterYFromTop(row: number): number { return cellCenterY(row); }
export function cellCenterXFromLeft(col: number): number { return cellCenterX(col); }

// Converts a client X coordinate to a grid column index, or null if outside the grid.
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

// Converts a client Y coordinate to a grid row index, or null if outside the
// grid. Mirrors pixelToCol — needed for lane selection when gravity mode's
// entry edge is left/right (lanes are rows, not columns).
export function pixelToRow(canvasRect: DOMRect, clientY: number): number | null {
  const renderedGridH = canvasRect.height * (gridH() / canvasLogicalHeight());
  const renderedOriginY = canvasRect.height * (gridOriginY() / canvasLogicalHeight());
  const y = clientY - canvasRect.top - renderedOriginY;
  const renderedCell = renderedGridH / gridRows();
  const row = Math.floor(y / renderedCell);
  return row >= 0 && row < gridRows() ? row : null;
}
