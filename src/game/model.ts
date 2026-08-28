export enum DiscKind {
  Numbered = 'numbered',
  SingleCracked = 'single-cracked',
  DoubleCracked = 'double-cracked',
}

export interface Disc {
  readonly id: number;
  value: number;
  kind: DiscKind;
  /** Player who placed this disc. undefined for solo modes and neutral discs. */
  ownerId?: string;
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

/**
 * The edge a disc entered through — the edge gravity currently pulls toward.
 *
 * @remarks
 * Declared here, not in `gravity/settling.ts`, so `events.ts` can use it on
 * {@link PushStep} without a `settling.ts` ↔ `events.ts` cycle.
 */
export type EntryEdge = 'top' | 'right' | 'bottom' | 'left';
