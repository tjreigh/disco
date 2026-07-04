import type { Board, Disc, GridPos } from '../model.js';
import { DiscKind } from '../model.js';
import type { RevealStep } from '../events.js';
import { StepKind } from '../events.js';
import type { GameModeConfig } from './mode.js';
import { countHorizontalRun, countVerticalRun } from '../board.js';

const DIRS: [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];

function classicIsClearable(board: Board, row: number, col: number, disc: Disc): boolean {
  if (disc.kind !== DiscKind.Numbered) return false;
  return disc.value === countHorizontalRun(board, row, col) ||
         disc.value === countVerticalRun(board, row, col);
}

// Degrades cracked discs orthogonally adjacent to the cleared positions.
// DoubleCracked → SingleCracked, SingleCracked → Numbered. The `updated` set
// ensures a cracked disc adjacent to multiple cleared cells in the same batch
// only loses one crack layer per clear event, not one per neighbor.
function classicRevealAdjacent(board: Board, cleared: GridPos[]): RevealStep {
  const rows = board.length;
  const cols = board[0]!.length;
  const positions: GridPos[] = [];
  const updated = new Set<string>();

  for (const { row, col } of cleared) {
    for (const [dr, dc] of DIRS) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
      const disc = board[r]![c];
      if (!disc) continue;
      const k = `${r},${c}`;
      if (updated.has(k)) continue;
      updated.add(k);

      if (disc.kind === DiscKind.DoubleCracked) {
        disc.kind = DiscKind.SingleCracked;
        positions.push({ row: r, col: c });
      } else if (disc.kind === DiscKind.SingleCracked) {
        disc.kind = DiscKind.Numbered;
        positions.push({ row: r, col: c });
      }
    }
  }

  // Animation steps are an event log, so capture values rather than mutable board
  // references. A later chain may reveal the same disc again before playback starts.
  const discs = positions.map(p => ({ ...board[p.row]![p.col]! }));
  return { kind: StepKind.Reveal, positions, discs };
}

function classicIsGameOver(board: Board): boolean {
  return board[0]!.some(cell => cell !== null);
}

export const CLASSIC_MODE: GameModeConfig = {
  id: 'classic',
  name: 'Classic',
  tagline: 'The original 7×7 Drop7 experience.',
  board: { cols: 7, rows: 7 },
  discValueMin: 1,
  discValueMax: 7,
  initialUnnumberedProbability: 0.30,
  unnumberedProbabilityLevelStep: 0.02,
  maxUnnumberedProbability: 0.60,
  pointsPerDisc: 7,
  chainExponent: 2.5,
  initialTurnsPerLevel: 30,
  turnsPerLevelStep: 1,
  minTurnsPerLevel: 8,
  isClearable: classicIsClearable,
  revealAdjacent: classicRevealAdjacent,
  isGameOver: classicIsGameOver,
};
