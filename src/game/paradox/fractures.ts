import { deepCloneBoard, landingRow, placeDisc } from '../board.js';
import { makeDisc, type QueuedDiscSnapshot } from '../disc.js';
import type { Board, GridPos } from '../model.js';
import { DiscKind } from '../model.js';

export interface ErasedTurn {
  anchor: GridPos;
  disc: QueuedDiscSnapshot;
}

export interface RewindFractureTarget {
  position: GridPos;
  discId?: number;
  discValue: number;
  resultingKind: DiscKind.SingleCracked | DiscKind.DoubleCracked;
  /** Total recoverable instability carried by this fracture after the rewind. */
  instabilityDebt: number;
  /** Portion of instabilityDebt introduced by the selected rewind. */
  instabilityAdded: number;
  /** True when the erased timeline must return a disc to create this target. */
  materialized: boolean;
}

export function applyRewindFractures(
  board: Board,
  fractures: readonly RewindFractureTarget[],
  instability: number,
): void {
  for (const target of fractures) {
    let disc = board[target.position.row]?.[target.position.col];
    if (!disc) {
      disc = makeDisc(target.discValue, target.resultingKind);
      placeDisc(board, target.position.row, target.position.col, disc);
    }
    disc.kind = target.resultingKind;
    disc.temporalFracture = {
      createdAtInstability: instability,
      instabilityDebt: target.instabilityDebt,
    };
  }
}

/** Migrates old or incomplete saves so every instability point has a repair path. */
export function reconcileTemporalDebt(
  board: Board,
  instability: number,
  anchor: GridPos,
  fallbackDiscValue: number,
): void {
  const fractures: GridPos[] = [];
  for (let row = 0; row < board.length; row++) {
    for (let col = 0; col < board[row]!.length; col++) {
      if (board[row]![col]?.temporalFracture) fractures.push({ row, col });
    }
  }
  sortNearest(fractures, anchor);

  let remaining = instability;
  for (const position of fractures) {
    const disc = board[position.row]![position.col]!;
    const debt = disc.temporalFracture!.instabilityDebt;
    const assigned = Math.min(debt, remaining);
    if (assigned === 0) {
      delete disc.temporalFracture;
    } else {
      disc.temporalFracture!.instabilityDebt = assigned;
      remaining -= assigned;
    }
  }
  if (remaining === 0) return;

  const missingDebt: ErasedTurn[] = Array.from({ length: remaining }, () => ({
    anchor: { ...anchor },
    disc: { value: fallbackDiscValue, kind: DiscKind.Numbered },
  }));
  const targets = selectRewindFractures(board, missingDebt, instability);
  applyRewindFractures(board, targets, instability);
}

export function selectRewindFractures(
  board: Board,
  erasedTurns: readonly ErasedTurn[],
  instability: number,
): RewindFractureTarget[] {
  const desiredKind = instability <= 2 ? DiscKind.SingleCracked : DiscKind.DoubleCracked;
  const scratch = deepCloneBoard(board);
  const targets = new Map<string, RewindFractureTarget>();
  const positionKey = (position: GridPos) => `${position.row}:${position.col}`;
  const resultingKind = (current: DiscKind): DiscKind.SingleCracked | DiscKind.DoubleCracked => (
    current === DiscKind.DoubleCracked || desiredKind === DiscKind.DoubleCracked
      ? DiscKind.DoubleCracked
      : DiscKind.SingleCracked
  );

  const addTarget = (
    position: GridPos,
    discValue: number,
    materialized: boolean,
    discId?: number,
  ): void => {
    const key = positionKey(position);
    const disc = scratch[position.row]![position.col];
    const existingDebt = disc?.temporalFracture?.instabilityDebt ?? 0;
    const kind = resultingKind(disc?.kind ?? desiredKind);
    const existingTarget = targets.get(key);
    if (existingTarget) {
      existingTarget.instabilityAdded++;
      existingTarget.instabilityDebt++;
    } else {
      targets.set(key, {
        position: { ...position },
        ...(discId !== undefined ? { discId } : {}),
        discValue,
        resultingKind: kind,
        instabilityDebt: existingDebt + 1,
        instabilityAdded: 1,
        materialized,
      });
    }
    const nextDebt = existingDebt + 1;
    if (disc) {
      disc.kind = kind;
      disc.temporalFracture = { createdAtInstability: instability, instabilityDebt: nextDebt };
    } else {
      scratch[position.row]![position.col] = {
        id: -(targets.size + 1),
        value: discValue,
        kind,
        temporalFracture: { createdAtInstability: instability, instabilityDebt: nextDebt },
      };
    }
  };

  for (const erased of erasedTurns) {
    const numbered: GridPos[] = [];
    for (let row = 0; row < scratch.length; row++) {
      for (let col = 0; col < scratch[row]!.length; col++) {
        const disc = scratch[row]![col];
        if (disc?.kind === DiscKind.Numbered && !disc.temporalFracture) numbered.push({ row, col });
      }
    }
    const numberedTarget = nearest(numbered, erased.anchor);
    if (numberedTarget) {
      const disc = scratch[numberedTarget.row]![numberedTarget.col]!;
      addTarget(numberedTarget, disc.value, false, disc.id);
      continue;
    }

    const emptyCount = scratch.reduce(
      (total, row) => total + row.filter(cell => cell === null).length,
      0,
    );
    if (emptyCount > 1) {
      const landings: GridPos[] = [];
      for (let col = 0; col < scratch[0]!.length; col++) {
        const row = landingRow(scratch, col);
        if (row !== null) landings.push({ row, col });
      }
      const remnantPosition = nearest(landings, erased.anchor);
      if (remnantPosition) {
        addTarget(remnantPosition, erased.disc.value, true);
        continue;
      }
    }

    const unclaimedCracked: GridPos[] = [];
    const temporal: GridPos[] = [];
    for (let row = 0; row < scratch.length; row++) {
      for (let col = 0; col < scratch[row]!.length; col++) {
        const disc = scratch[row]![col];
        if (!disc) continue;
        if (disc.temporalFracture) temporal.push({ row, col });
        else if (disc.kind !== DiscKind.Numbered) unclaimedCracked.push({ row, col });
      }
    }
    const fallback = nearest(unclaimedCracked, erased.anchor) ?? nearest(temporal, erased.anchor);
    if (!fallback) throw new Error('Unable to anchor Paradox instability on the restored board');
    const disc = scratch[fallback.row]![fallback.col]!;
    addTarget(fallback, disc.value, false, disc.id);
  }

  return [...targets.values()];
}

function nearest(positions: GridPos[], anchor: GridPos): GridPos | undefined {
  return sortNearest(positions, anchor)[0];
}

function sortNearest(positions: GridPos[], anchor: GridPos): GridPos[] {
  return positions.sort((a, b) => {
    const distanceA = Math.abs(a.row - anchor.row) + Math.abs(a.col - anchor.col);
    const distanceB = Math.abs(b.row - anchor.row) + Math.abs(b.col - anchor.col);
    return distanceA - distanceB || b.row - a.row || a.col - b.col;
  });
}
