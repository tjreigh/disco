import { countHorizontalRun, countVerticalRun, isBoardFull } from '../board.js';
import type { RevealStep } from '../events.js';
import { StepKind } from '../events.js';
import type { Board, Disc, GridPos } from '../model.js';
import { DiscKind } from '../model.js';
import { gravityRunLengths } from '../gravity/settling.js';
import type {
  BoardRules,
  ClearingRules,
  FailureRules,
  GenerationRules,
  PlacementRules,
  ProgressionRules,
  RevealRules,
  RewindRuleModifier,
  ScoringRules,
} from './mode.js';

const DIRECTIONS: readonly [number, number][] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

function orthogonalCountMatch(
  board: Board,
  row: number,
  col: number,
  disc: Disc,
): boolean {
  if (disc.kind !== DiscKind.Numbered) return false;
  return disc.value === countHorizontalRun(board, row, col)
    || disc.value === countVerticalRun(board, row, col);
}

function gravityAlignedCountMatch(
  board: Board,
  row: number,
  col: number,
  disc: Disc,
  angleDeg = 0,
): boolean {
  if (disc.kind !== DiscKind.Numbered) return false;
  const { alongGravity, crossGravity } = gravityRunLengths(board, row, col, angleDeg);
  return disc.value === alongGravity || disc.value === crossGravity;
}

function adjacentCrackReveal(board: Board, cleared: GridPos[]): RevealStep {
  const rows = board.length;
  const cols = board[0]!.length;
  const positions: GridPos[] = [];
  const temporalRepairs: GridPos[] = [];
  let instabilityRecovered = 0;
  const updated = new Set<string>();

  for (const { row, col } of cleared) {
    for (const [rowDelta, colDelta] of DIRECTIONS) {
      const nextRow = row + rowDelta;
      const nextCol = col + colDelta;
      if (nextRow < 0 || nextRow >= rows || nextCol < 0 || nextCol >= cols) continue;
      const disc = board[nextRow]![nextCol];
      if (!disc) continue;
      const key = `${nextRow},${nextCol}`;
      if (updated.has(key)) continue;
      updated.add(key);

      if (disc.kind === DiscKind.DoubleCracked) {
        disc.kind = DiscKind.SingleCracked;
        positions.push({ row: nextRow, col: nextCol });
      } else if (disc.kind === DiscKind.SingleCracked) {
        disc.kind = DiscKind.Numbered;
        if (disc.temporalFracture) {
          temporalRepairs.push({ row: nextRow, col: nextCol });
          instabilityRecovered += disc.temporalFracture.instabilityDebt;
          delete disc.temporalFracture;
        }
        positions.push({ row: nextRow, col: nextCol });
      }
    }
  }

  const discs = positions.map(position => ({ ...board[position.row]![position.col]! }));
  return {
    kind: StepKind.Reveal,
    positions,
    discs,
    ...(temporalRepairs.length > 0 ? { temporalRepairs, instabilityRecovered } : {}),
  };
}

export const SEVEN_BY_SEVEN: BoardRules = {
  kind: 'rectangular-grid@1',
  cols: 7,
  rows: 7,
};

export const DOWNWARD_DROP: PlacementRules = {
  kind: 'downward-drop@1',
};

export const STAGE_AND_TILT: PlacementRules = {
  kind: 'stage-and-tilt@1',
  initialAngleDeg: 0,
  maxTiltDeltaDeg: 90,
};

export const ORTHOGONAL_COUNT_MATCH: ClearingRules = {
  kind: 'orthogonal-count-match@1',
  isClearable: orthogonalCountMatch,
};

export const GRAVITY_ALIGNED_COUNT_MATCH: ClearingRules = {
  kind: 'gravity-aligned-count-match@1',
  isClearable: gravityAlignedCountMatch,
};

export const ADJACENT_CRACK_REVEAL: RevealRules = {
  kind: 'adjacent-crack-reveal@1',
  revealAdjacent: adjacentCrackReveal,
};

export const CLASSIC_ADAPTIVE_GENERATION: GenerationRules = {
  kind: 'adaptive-history@1',
  discValueMin: 1,
  discValueMax: 7,
  initialUnnumberedProbability: 0.20,
  unnumberedProbabilityLevelStep: 0.01,
  maxUnnumberedProbability: 0.40,
  minLevelForBoardClearBonus: 2,
  boardAdaptive: true,
  maxSameValueRun: 3,
  maxNumberedRun: 6,
  maxCrackedRun: 2,
  valueBalanceWindow: 14,
  valueBalanceStrength: 0.75,
  kindBalanceWindow: 50,
  kindBalanceStrength: 1,
  boardPressureStartHeight: 2,
  boardPressureStrength: 1.5,
  boardRelevanceStrength: 0.75,
};

export const STACK_ADAPTIVE_GENERATION: GenerationRules = {
  kind: 'adaptive-history@1',
  discValueMin: 1,
  discValueMax: 7,
  initialUnnumberedProbability: 0,
  unnumberedProbabilityLevelStep: 0,
  maxUnnumberedProbability: 0,
  minLevelForBoardClearBonus: 2,
  boardAdaptive: true,
  maxSameValueRun: 3,
  maxNumberedRun: 6,
  maxCrackedRun: 2,
  valueBalanceWindow: 14,
  valueBalanceStrength: 0.75,
  kindBalanceWindow: 50,
  kindBalanceStrength: 1,
  boardPressureStartHeight: 2,
  boardPressureStrength: 1.5,
  boardRelevanceStrength: 0.75,
};

export const CLASSIC_CHAIN_SCORING: ScoringRules = {
  kind: 'chain-score@1',
  pointsPerDisc: 7,
  chainExponent: 2.5,
  levelBonus: 7_000,
  boardClearBonus: 70_000,
};

export const STACK_SCORING: ScoringRules = {
  kind: 'stack-score@1',
  pointsPerStackUnit: 10,
  levelBonus: 7_000,
  boardClearBonus: 70_000,
};

export const CLASSIC_LEVEL_PRESSURE: ProgressionRules = {
  kind: 'level-pressure@1',
  initialTurnsPerLevel: 30,
  turnsPerLevelStep: 1,
  minTurnsPerLevel: 8,
};

export const STACK_LEVEL_PRESSURE: ProgressionRules = {
  kind: 'level-pressure@1',
  initialTurnsPerLevel: 22,
  turnsPerLevelStep: 1,
  minTurnsPerLevel: 8,
};

export const OVERFLOW_OR_FULL_BOARD_ENDS_RUN: FailureRules = {
  kind: 'overflow-or-full-board-ends-run@1',
  isTerminalBoard: isBoardFull,
  gameOverReason: (pushOverflow, board) => (
    pushOverflow ? 'push-overflow' : isBoardFull(board) ? 'board-full' : undefined
  ),
};

export const PARADOX_REWIND: RewindRuleModifier = {
  kind: 'rewind-instability@1',
  historyDepth: 5,
  criticalInstability: 5,
  pressureStepInstability: 3,
  maxTurnCost: 3,
  temporalEcho: {
    tiers: [
      { minimumInstability: 5, probability: 0.1 },
      { minimumInstability: 6, probability: 0.2 },
      { minimumInstability: 9, probability: 0.3 },
    ],
  },
};
