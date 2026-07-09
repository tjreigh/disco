export enum DiscKind {
  Numbered = 'numbered',
  SingleCracked = 'single-cracked',
  DoubleCracked = 'double-cracked',
}

export interface Disc {
  readonly id: number;
  value: number;
  kind: DiscKind;
}

export type Cell = Disc | null;

/** [row][col], with row 0 at the top. */
export type Board = Cell[][];

export interface GridPos {
  row: number;
  col: number;
}
