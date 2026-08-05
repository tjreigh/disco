// Maximum cell size on large screens; shrinks on small viewports.
export const MAX_CELL_SIZE = 72;
export const MIN_CELL_SIZE = 40;
export const HUD_TOP_HEIGHT   = 96;
export const HUD_BOTTOM_HEIGHT = 80;

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
// Opponent's live column preview in Disco Duel — matches the orange used for
// "OPPONENT" in the shared-board HUD, so the two read as the same signal.
export const COLOR_OPPONENT_GHOST = 'rgba(246,173,85,0.35)';
export const COLOR_SCORE_POPUP  = '#ffd700'; // warm gold — floating "+N" score popups
export const COLOR_COL_HOVER    = 'rgba(255,255,255,0.07)';
export const COLOR_GAMEOVER_BG  = 'rgba(0,0,0,0.75)';
export const COLOR_GRAVITY_ACCENT = '#62b0e8'; // gravity compass, tilt arc, direction gradient
// Diagonal lane overlay (rgba form of COLOR_GRAVITY_ACCENT — canvas dashed
// strokes need per-stroke alpha, which a hex constant alone can't express).
// Only drawn at the 4 diagonal snap angles, where clearing checks a diagonal
// axis but a pile packed against a wall can still visually read as a plain
// column/row — the lattice makes the actual check axis visible on the board
// itself instead of only inferable from the compass.
export const COLOR_GRAVITY_LANE = 'rgba(98, 176, 232, 0.28)';
