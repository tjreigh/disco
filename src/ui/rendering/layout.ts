import { MAX_CELL_SIZE, MIN_CELL_SIZE, HUD_TOP_HEIGHT, HUD_BOTTOM_HEIGHT, GRID_COLS, GRID_ROWS } from './theme.js';

// Vertical gap above and below the grid within the canvas (fixed — only
// horizontal padding is dynamic).
const GRID_PAD_V = 8;

// Module-level cell size, updated by updateCellSize() on every resize.
// All geometry functions read from this so a single resize call propagates everywhere.
let _cellSize = MAX_CELL_SIZE;

// Recomputes the cell size to fit the current viewport. Should be called at
// startup and on every window resize before the canvas dimensions are recalculated.
export function updateCellSize(): void {
  const availW = window.innerWidth;
  const availH = window.innerHeight - HUD_TOP_HEIGHT - HUD_BOTTOM_HEIGHT - GRID_PAD_V * 2;
  const byWidth  = Math.floor(availW / GRID_COLS);
  const byHeight = Math.floor(availH / GRID_ROWS);
  _cellSize = Math.max(MIN_CELL_SIZE, Math.min(MAX_CELL_SIZE, byWidth, byHeight));
}

export function cellSize(): number { return _cellSize; }

// Centers the grid horizontally — uses whatever space the viewport leaves after
// fitting the cells. At least 4px so discs don't clip the canvas edge.
export function gridPadding(): number {
  return Math.max(4, Math.floor((window.innerWidth - _cellSize * GRID_COLS) / 2));
}

export function gridW(): number { return _cellSize * GRID_COLS; }
export function gridH(): number { return _cellSize * GRID_ROWS; }

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
  const renderedCell = renderedGridW / GRID_COLS;
  const col = Math.floor(x / renderedCell);
  return col >= 0 && col < GRID_COLS ? col : null;
}
