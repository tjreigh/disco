import type { Disc, EntryEdge, GridPos } from './model.js';

export enum StepKind {
  Drop = 'drop',
  Clear = 'clear',
  Fall = 'fall',
  Reveal = 'reveal',
  Push = 'push',
  Bonus = 'bonus',
}

export interface DropStep {
  kind: StepKind.Drop;
  disc: Disc;
  /** This drop was repeated by Paradox instability and does not spend another turn. */
  temporalEcho?: true;
  /** Off-board animation start position, one cell beyond the entry edge. */
  entryPos: GridPos;
  /** True final resting position on the board, already post-settle. */
  landPos: GridPos;
}

export interface ClearStep {
  kind: StepKind.Clear;
  cleared: GridPos[];
  discs: Disc[];
  chainLevel: number;
  pointsAwarded: number;
}

export interface FallStep {
  kind: StepKind.Fall;
  /**
   * Disc movements for this step. Each move's optional `path` is the waypoint
   * sequence the disc actually travelled (starting with `from`), when known.
   *
   * @remarks
   * {@link settleContinuous} can route a disc around obstacles across several
   * passes; animation should follow `path` when present. Omitted for a plain
   * straight hop, or a settle function that only ever moves discs straight.
   */
  moves: Array<{ from: GridPos; to: GridPos; disc: Disc; path?: GridPos[] }>;
}

export interface RevealStep {
  kind: StepKind.Reveal;
  positions: GridPos[];
  discs: Disc[];
  /** Temporal fractures whose final cover was removed by this reveal batch. */
  temporalRepairs?: GridPos[];
  /** Total instability debt carried by temporalRepairs. */
  instabilityRecovered?: number;
}

export interface PushStep {
  kind: StepKind.Push;
  /**
   * The edge the new discs entered from — the edge gravity currently pulls
   * toward (Classic: always `bottom`; Gravity: the current floor edge).
   *
   * @remarks
   * `top`/`bottom` → `newDiscs` is a row indexed by column; `left`/`right` → a
   * column indexed by row.
   */
  edge: EntryEdge;
  newDiscs: Disc[];
}

export const BONUS_KINDS = ['level', 'board-clear', 'stack', 'balanced'] as const;
export type BonusKind = (typeof BONUS_KINDS)[number];

export interface BonusStep {
  kind: StepKind.Bonus;
  bonusKind: BonusKind;
  pointsAwarded: number;
}

export type PhysicsStep = DropStep | ClearStep | FallStep | RevealStep | PushStep | BonusStep;
