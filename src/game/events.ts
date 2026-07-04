import type { Disc, GridPos } from './model.js';

export const enum StepKind {
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
  moves: Array<{ from: GridPos; to: GridPos; disc: Disc }>;
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
