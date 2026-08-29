import type { Board, Disc } from './model.js';

export enum GamePhase {
  Menu = 'menu',
  WaitingForDrop = 'waiting',
  /** Gravity mode only: a lane is staged and its required rotation is in progress. */
  Aiming = 'aiming',
  Animating = 'animating',
  GameOver = 'game-over',
}

export interface GravityState {
  /**
   * Current gravity angle in degrees, continuous and unbounded (not
   * normalized mod 360). 0 = straight down. Drags continuously during
   * GamePhase.Aiming (see tiltGravity), but GameEngine.commitTilt snaps and
   * persists it to the nearest of 8 directions (0/45/90/.../315) — so
   * outside of Aiming this always holds one of those 8 exact values. See
   * snapAngleToEightDirections in gravity/settling.ts for why: settling only
   * produces a shape the clear-checker fully recognizes as a line at those
   * 8 angles, so leaving it unsnapped made piles that visibly looked like a
   * line not clear.
   */
  angle: number;
  /** Angle at the start of the in-progress tilt action — tiltGravity/cancelTilt use this as the reference point, not the raw angle. */
  turnStartAngle: number;
  /** Maximum absolute tilt allowed from turnStartAngle for one tilt action. */
  maxTiltDelta: number;
  /** Selected lane for the staged gravity turn; absent outside GamePhase.Aiming. */
  pendingLane?: number;
}

export interface ParadoxState {
  instability: number;
}

export interface GameState {
  /** Seed controlling both deterministic disc-generation streams. */
  generationSeed: number;
  /**
   * Whether generationSeed actually drove disc generation ('seeded') or a
   * custom-injected factory did ('injected'). Replaying a game deterministically
   * from generationSeed alone is only valid when this is 'seeded' — an injected
   * factory is not reproducible from the seed.
   */
  generationSource: 'seeded' | 'injected';
  phase: GamePhase;
  board: Board;
  currentDisc: Disc;
  nextDisc: Disc;
  /** Column cursor for top/bottom entry; reinterpreted as a row cursor for left/right entry (Gravity mode only) — the axis is determined by the mode's current entry edge, not by this field's name. */
  cursorCol: number;
  score: number;
  /** Shared-board multiplayer: score for player 1. undefined in solo modes. */
  scorePlayer1?: number;
  /** Shared-board multiplayer: score for player 2. undefined in solo modes. */
  scorePlayer2?: number;
  /** Shared-board multiplayer: which player ID's turn it is. undefined in solo modes. */
  activePlayerId?: string;
  dropCount: number;
  level: number;
  /** Total turn budget for the current level (fixed until the level changes). */
  turnsPerLevel: number;
  /** Turns left within the current level's budget. */
  turnsRemaining: number;
  /** Numbered discs cleared so far in the current level (Ration mode only). */
  breaksThisLevel: number;
  /** Ration imbalance meter; the run ends when this reaches the mode threshold. */
  entropy: number;
  /** Levels finished inside the Ration band (Ration mode only). */
  balancedLevels: number;
  /** Only present for Gravity mode. */
  gravity?: GravityState | undefined;
  /** Only present for rewind-capable modes. */
  paradox?: ParadoxState | undefined;
}
