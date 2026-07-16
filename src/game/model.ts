export enum DiscKind {
  Numbered = 'numbered',
  SingleCracked = 'single-cracked',
  DoubleCracked = 'double-cracked',
}

export interface Disc {
  readonly id: number;
  value: number;
  kind: DiscKind;
  /** Present while a Paradox rewind fracture is still covered. */
  temporalFracture?: {
    createdAtInstability: number;
    /** Instability restored when the fracture's final crack layer is removed. */
    instabilityDebt: number;
  };
}

export type Cell = Disc | null;

/** [row][col], with row 0 at the top. */
export type Board = Cell[][];

export interface GridPos {
  row: number;
  col: number;
}

// Lives here (not gravity/settling.ts) so events.ts can reference it on
// PushStep without settling.ts <-> events.ts becoming a circular import.
export type EntryEdge = 'top' | 'right' | 'bottom' | 'left';
