import type { Board, Disc } from './model.js';

export enum GamePhase {
  Menu = 'menu',
  WaitingForDrop = 'waiting',
  Animating = 'animating',
  GameOver = 'game-over',
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
  cursorCol: number;
  score: number;
  dropCount: number;
  level: number;
  /** Total turn budget for the current level (fixed until the level changes). */
  turnsPerLevel: number;
  /** Turns left within the current level's budget. */
  turnsRemaining: number;
}
