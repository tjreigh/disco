import type { Board, Disc } from './model.js';

export const enum GamePhase {
  Menu = 'menu',
  WaitingForDrop = 'waiting',
  Animating = 'animating',
  GameOver = 'game-over',
}

export interface GameState {
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
