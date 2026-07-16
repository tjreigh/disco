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
  // `path` is the full waypoint sequence a disc actually traveled to reach
  // `to` (starting with `from`), when known — e.g. settleContinuous's
  // continuous-angle packing can route a disc around obstacles across
  // several internal passes before it reaches its true resting cell.
  // Animation should follow `path` when present instead of a straight line
  // from `from` to `to`. Omitted where there's nothing to distinguish (a
  // single straight hop, or a settle function — like the classic per-lane
  // one — that never produces anything but a straight line).
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
  // The edge the new discs entered from — the edge gravity currently pulls
  // TOWARD (Classic always 'bottom'; Gravity mode's floor edge, which
  // changes with the tilt). 'top'/'bottom' means newDiscs is a new ROW
  // (indexed by column); 'left'/'right' means a new COLUMN (indexed by row).
  edge: EntryEdge;
  newDiscs: Disc[];
}

export type BonusKind = 'level' | 'board-clear' | 'stack';

export interface BonusStep {
  kind: StepKind.Bonus;
  bonusKind: BonusKind;
  pointsAwarded: number;
}

export type PhysicsStep = DropStep | ClearStep | FallStep | RevealStep | PushStep | BonusStep;
