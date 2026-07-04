import type { Board, Disc, GridPos } from '../model.js';
import type { RevealStep } from '../events.js';

export interface GameModeConfig {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly board: { cols: number; rows: number };
  readonly discValueMin: number;
  readonly discValueMax: number;
  readonly initialUnnumberedProbability: number;
  readonly unnumberedProbabilityLevelStep: number;
  readonly maxUnnumberedProbability: number;
  readonly pointsPerDisc: number;
  readonly chainExponent: number;
  readonly initialTurnsPerLevel: number;
  readonly turnsPerLevelStep: number;
  readonly minTurnsPerLevel: number;
  isClearable(board: Board, row: number, col: number, disc: Disc): boolean;
  revealAdjacent(board: Board, cleared: GridPos[]): RevealStep;
  isGameOver(board: Board): boolean;
}

// Turn budget for a given level: shrinks by turnsPerLevelStep per level from
// initialTurnsPerLevel, floored at minTurnsPerLevel.
export function turnsForLevel(mode: GameModeConfig, level: number): number {
  return Math.max(mode.minTurnsPerLevel, mode.initialTurnsPerLevel - mode.turnsPerLevelStep * (level - 1));
}

/** Chance that a dealt disc is unnumbered at a given one-based level. */
export function unnumberedProbabilityForLevel(mode: GameModeConfig, level: number): number {
  const levelOffset = Math.max(1, level) - 1;
  return Math.min(
    mode.maxUnnumberedProbability,
    mode.initialUnnumberedProbability + mode.unnumberedProbabilityLevelStep * levelOffset,
  );
}
