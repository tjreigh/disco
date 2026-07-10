import type { Disc, GridPos } from './model.js';

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
  col: number;
  toLandRow: number;
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
}

export interface PushStep {
  kind: StepKind.Push;
  newRow: Disc[];
}

export type BonusKind = 'level' | 'board-clear';

export interface BonusStep {
  kind: StepKind.Bonus;
  bonusKind: BonusKind;
  pointsAwarded: number;
}

export type PhysicsStep = DropStep | ClearStep | FallStep | RevealStep | PushStep | BonusStep;
