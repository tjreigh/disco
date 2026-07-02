export const GRID_COLS = 7;
export const GRID_ROWS = 7;

// Maximum cell size on large screens; shrinks on small viewports.
export const MAX_CELL_SIZE = 72;
export const MIN_CELL_SIZE = 40;
export const HUD_TOP_HEIGHT   = 60;  // px for score / level bar above grid
export const HUD_BOTTOM_HEIGHT = 80; // px for current-disc / next-disc bar below grid

// Animation durations (ms).
// Drop and fall are scaled per row so faster drops don't look teleported.
export const DROP_MS_PER_ROW = 60;
export const FLASH_MS        = 280; // pre-clear pulse before discs disappear
export const CLEAR_MS        = 320; // fade-out / shrink after the flash
export const FALL_MS_PER_ROW = 55;
export const REVEAL_MS       = 350; // crack-layer transition pulse
export const PUSH_MS         = 420; // new row sliding up from below

// A new row of cracked discs is pushed up every 7 drops — matching the board
// width so the pressure scales with how fast the player fills columns.
export const DROPS_PER_PUSH = 7;

// A disc cleared at chain length n is worth floor(7 × n^2.5):
// 7, 39, 109, 224, 391, ... This is the original Drop7 progression and does
// not cap, so unusually long chains continue to become more valuable.
export const POINTS_PER_DISC = 7;

// Probability thresholds for the random disc drawn from the queue.
// Roll r in [0, 1): r < 0.70 → Numbered, r < 0.85 → SingleCracked, else DoubleCracked.
export const PROB_NUMBERED       = 0.70;
export const PROB_SINGLE_CRACKED = 0.85;

// One color per disc value 1–7 (index 0 = value 1).
export const DISC_COLORS = [
  '#e74c3c', // 1 — red
  '#e67e22', // 2 — orange
  '#f1c40f', // 3 — yellow
  '#2ecc71', // 4 — green
  '#3498db', // 5 — blue
  '#9b59b6', // 6 — purple
  '#1abc9c', // 7 — teal
] as const;

export const COLOR_BG           = '#1a1a2e';
export const COLOR_GRID_CELL    = '#16213e';
export const COLOR_GRID_LINE    = '#0f3460';
export const COLOR_CRACKED_FILL = '#4a5568';
export const COLOR_CRACKED_DARK = '#2d3748';
export const COLOR_CRACK_LINE   = '#e2e8f0';
export const COLOR_TEXT         = '#ffffff';
export const COLOR_TEXT_DIM     = '#a0aec0';
export const COLOR_GHOST        = 'rgba(255,255,255,0.18)';
export const COLOR_COL_HOVER    = 'rgba(255,255,255,0.07)';
export const COLOR_GAMEOVER_BG  = 'rgba(0,0,0,0.75)';
