import { describe, test, expect } from 'vitest';
import { computeClearSteps, computeDropSteps, computePushStep, pointsForChain } from './physics.js';
import { makeEmptyBoard, placeDisc } from './board.js';
import { makeDisc } from './disc.js';
import { DiscKind, StepKind, Board, ClearStep, FallStep, RevealStep, DropStep } from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

type CellSpec = { r: number; c: number; value: number; kind?: DiscKind };

function buildBoard(cells: CellSpec[]): Board {
  const board = makeEmptyBoard();
  for (const { r, c, value, kind = DiscKind.Numbered } of cells) {
    placeDisc(board, r, c, makeDisc(value, kind));
  }
  return board;
}

function n(value: number): CellSpec { return { r: 0, c: 0, value, kind: DiscKind.Numbered }; }
function at(r: number, c: number, value: number, kind = DiscKind.Numbered): CellSpec {
  return { r, c, value, kind };
}

// ─── computeDropSteps ────────────────────────────────────────────────────────

describe('computeDropSteps – disc placement', () => {
  test('disc lands at bottom row of an empty column', () => {
    const board = makeEmptyBoard();
    const disc = makeDisc(1, DiscKind.Numbered);
    const steps = computeDropSteps(board, disc, 3);
    const drop = steps[0] as DropStep;
    expect(drop.kind).toBe(StepKind.Drop);
    expect(drop.toLandRow).toBe(6);
    expect(drop.col).toBe(3);
  });

  test('board is committed in-place after the call', () => {
    const board = makeEmptyBoard();
    // val=7: col count=1 and row count=1 after drop, neither matches 7, so no clear.
    const disc = makeDisc(7, DiscKind.Numbered);
    computeDropSteps(board, disc, 0);
    expect(board[6]![0]).toBe(disc);
  });

  test('disc stacks on top of existing discs', () => {
    const board = buildBoard([at(6, 2, 5), at(5, 2, 4)]);
    const disc = makeDisc(3, DiscKind.Numbered);
    const steps = computeDropSteps(board, disc, 2);
    const drop = steps[0] as DropStep;
    expect(drop.toLandRow).toBe(4);
  });

  test('returns empty array for a full column', () => {
    const board = makeEmptyBoard();
    for (let r = 0; r < 7; r++) placeDisc(board, r, 0, makeDisc(1, DiscKind.Numbered));
    const steps = computeDropSteps(board, makeDisc(1, DiscKind.Numbered), 0);
    expect(steps.length).toBe(0);
  });
});

// ─── Clear rules ─────────────────────────────────────────────────────────────

describe('computeDropSteps – clear by row count', () => {
  test('numbered disc clears when its value equals the row disc count', () => {
    // Row 6 will have 3 discs after drop; fillers have values that cannot match
    // count=3 (val=5) or col count=1 (val=5 and val=4).
    const board = buildBoard([
      at(6, 0, 5),
      at(6, 1, 4),
    ]);
    const steps = computeDropSteps(board, makeDisc(3, DiscKind.Numbered), 2);
    const clears = steps.filter(s => s.kind === StepKind.Clear) as ClearStep[];
    expect(clears.length).toBe(1);
    expect(clears[0]!.cleared).toContainEqual({ row: 6, col: 2 });
    expect(clears[0]!.chainLevel).toBe(0);
  });

  test('an isolated 1 clears despite another disc beyond a horizontal gap', () => {
    const board = buildBoard([
      at(6, 0, 1),
      at(6, 2, 7, DiscKind.DoubleCracked),
    ]);

    const steps = computeClearSteps(board);
    const clears = steps.filter(s => s.kind === StepKind.Clear) as ClearStep[];

    expect(clears[0]!.cleared).toContainEqual({ row: 6, col: 0 });
    expect(board[6]![0]).toBeNull();
  });
});

describe('computeDropSteps – clear by col count', () => {
  test('numbered disc clears when its value equals the column disc count', () => {
    // Col 2 will have 3 discs after drop; fillers have values that won't match.
    const board = buildBoard([
      at(4, 2, 5),
      at(5, 2, 4),
    ]);
    const steps = computeDropSteps(board, makeDisc(3, DiscKind.Numbered), 2);
    const clears = steps.filter(s => s.kind === StepKind.Clear) as ClearStep[];
    expect(clears.length).toBe(1);
    expect(clears[0]!.cleared).toContainEqual({ row: 6, col: 2 });
  });
});

describe('computeDropSteps – cracked discs do not clear', () => {
  test('SingleCracked disc with value matching row count does not clear', () => {
    const board = buildBoard([at(6, 0, 5), at(6, 1, 4)]);
    // Row 6 will have 3 discs; dropped disc val=3 = row count, but it's cracked.
    const steps = computeDropSteps(board, makeDisc(3, DiscKind.SingleCracked), 2);
    const clears = steps.filter(s => s.kind === StepKind.Clear);
    expect(clears.length).toBe(0);
  });

  test('DoubleCracked disc with value matching col count does not clear', () => {
    const board = buildBoard([at(4, 0, 5), at(5, 0, 4)]);
    const steps = computeDropSteps(board, makeDisc(3, DiscKind.DoubleCracked), 0);
    const clears = steps.filter(s => s.kind === StepKind.Clear);
    expect(clears.length).toBe(0);
  });
});

// ─── Crack reveal rules ──────────────────────────────────────────────────────

describe('computeDropSteps – crack reveals', () => {
  test('playback snapshots preserve each state of a disc revealed during its drop', () => {
    const board = buildBoard([at(6, 0, 2)]);
    const dropped = makeDisc(7, DiscKind.DoubleCracked);

    const steps = computeDropSteps(board, dropped, 1);
    const drop = steps.find(s => s.kind === StepKind.Drop) as DropStep;
    const reveal = steps.find(s => s.kind === StepKind.Reveal) as RevealStep;

    expect(drop.disc.kind).toBe(DiscKind.DoubleCracked);
    expect(reveal.discs[0]!.kind).toBe(DiscKind.SingleCracked);
    expect(board[6]![1]!.kind).toBe(DiscKind.SingleCracked);
    expect(drop.disc).not.toBe(board[6]![1]);
    expect(reveal.discs[0]).not.toBe(board[6]![1]);
  });

  test('DoubleCracked adjacent to a clear degrades to SingleCracked', () => {
    // Row 6 has 3 discs after drop; val=3 at col 2 clears.
    // DoubleCracked at (6,1) is adjacent and degrades.
    const board = buildBoard([
      at(6, 0, 5),
      at(6, 1, 9, DiscKind.DoubleCracked),
    ]);
    computeDropSteps(board, makeDisc(3, DiscKind.Numbered), 2);
    expect(board[6]![1]!.kind).toBe(DiscKind.SingleCracked);
  });

  test('SingleCracked adjacent to a clear degrades to Numbered', () => {
    // val=6 so after reveal (kind→Numbered) the disc's value won't match
    // row count=2 or col count=1, preventing a cascade clear.
    const board = buildBoard([
      at(6, 0, 5),
      at(6, 1, 6, DiscKind.SingleCracked),
    ]);
    computeDropSteps(board, makeDisc(3, DiscKind.Numbered), 2);
    expect(board[6]![1]!.kind).toBe(DiscKind.Numbered);
  });

  test('RevealStep is emitted when a cracked disc degrades', () => {
    const board = buildBoard([
      at(6, 0, 5),
      at(6, 1, 9, DiscKind.DoubleCracked),
    ]);
    const steps = computeDropSteps(board, makeDisc(3, DiscKind.Numbered), 2);
    const reveals = steps.filter(s => s.kind === StepKind.Reveal) as RevealStep[];
    expect(reveals.length).toBe(1);
    expect(reveals[0]!.positions).toContainEqual({ row: 6, col: 1 });
  });

  test('no RevealStep when no cracked discs are adjacent to a clear', () => {
    // Only numbered discs around the clearing position.
    const board = buildBoard([at(6, 0, 5), at(6, 1, 4)]);
    const steps = computeDropSteps(board, makeDisc(3, DiscKind.Numbered), 2);
    const reveals = steps.filter(s => s.kind === StepKind.Reveal);
    expect(reveals.length).toBe(0);
  });
});

describe('computeDropSteps – multi-adjacency', () => {
  test('disc adjacent to 2 cleared cells degrades only once per clear event', () => {
    // Row 5 has 3 discs: val=3 on both ends, DoubleCracked in the middle.
    // Dropping val=7 into col 6 (won't itself clear) triggers findClears,
    // which finds both val=3 discs. (5,1) is adjacent to both cleared positions
    // but must only lose one crack layer.
    const board = buildBoard([
      at(5, 0, 3),
      at(5, 1, 9, DiscKind.DoubleCracked),
      at(5, 2, 3),
    ]);
    computeDropSteps(board, makeDisc(7, DiscKind.Numbered), 6);
    // (5,0) and (5,2) cleared → (5,1) degrades DoubleCracked→SingleCracked,
    // then falls to row 6 via gravity. Check final position.
    expect(board[6]![1]!.kind).toBe(DiscKind.SingleCracked);
  });
});

// ─── Chain reactions ──────────────────────────────────────────────────────────

describe('computeDropSteps – chain reactions', () => {
  test('uses the original unbounded Drop7 chain score sequence', () => {
    expect([1, 2, 3, 4, 5, 6].map(pointsForChain)).toEqual([
      7, 39, 109, 224, 391, 617,
    ]);
    expect(pointsForChain(30)).toBe(34506);
  });

  test('gravity after first clear enables a second clear at higher chain level', () => {
    // (3,0) val=1 is above (6,0) val=2 which clears in chain 0 (col count=2).
    // (3,4) val=7 keeps row 3 at count=2, preventing (3,0) val=1 from self-clearing
    // by row in chain 0 (row count=2 ≠ val=1).
    // After chain 0 clears (6,0),(6,1),(6,2): (3,0) falls to (6,0), col count=1=val=1 → chain 1.
    const board = buildBoard([
      at(3, 0, 1),
      at(3, 4, 7), // companion: keeps row 3 count=2 so (3,0) doesn't self-clear in chain 0
      at(6, 0, 2),
      at(6, 1, 1),
      at(6, 2, 1),
    ]);
    // val=7 into col 3: col 3 count=1, 7≠1. No clear from dropped disc.
    const steps = computeDropSteps(board, makeDisc(7, DiscKind.Numbered), 3);
    const clears = steps.filter(s => s.kind === StepKind.Clear) as ClearStep[];
    expect(clears.length).toBe(2);
    expect(clears[0]!.chainLevel).toBe(0);
    expect(clears[1]!.chainLevel).toBe(1);
  });

  test('scoring: chain 0 awards clearedCount × 7 × 1', () => {
    // 3 discs clear in chain 0: 3 × 7 × 1 = 21
    const board = buildBoard([
      at(3, 0, 1), at(3, 4, 7),
      at(6, 0, 2), at(6, 1, 1), at(6, 2, 1),
    ]);
    const steps = computeDropSteps(board, makeDisc(7, DiscKind.Numbered), 3);
    const clears = steps.filter(s => s.kind === StepKind.Clear) as ClearStep[];
    expect(clears[0]!.pointsAwarded).toBe(3 * 7 * 1); // 21
  });

  test('scoring: chain 1 awards 39 points per cleared disc', () => {
    const board = buildBoard([
      at(3, 0, 1), at(3, 4, 7),
      at(6, 0, 2), at(6, 1, 1), at(6, 2, 1),
    ]);
    const steps = computeDropSteps(board, makeDisc(7, DiscKind.Numbered), 3);
    const clears = steps.filter(s => s.kind === StepKind.Clear) as ClearStep[];
    expect(clears[1]!.pointsAwarded).toBe(39);
  });

  test('FallStep appears between the two ClearSteps', () => {
    const board = buildBoard([
      at(3, 0, 1), at(3, 4, 7),
      at(6, 0, 2), at(6, 1, 1), at(6, 2, 1),
    ]);
    const steps = computeDropSteps(board, makeDisc(7, DiscKind.Numbered), 3);
    const clearIdx0 = steps.findIndex(s => s.kind === StepKind.Clear);
    const clearIdx1 = steps.findLastIndex(s => s.kind === StepKind.Clear);
    const fallBetween = steps
      .slice(clearIdx0 + 1, clearIdx1)
      .some(s => s.kind === StepKind.Fall);
    expect(fallBetween).toBe(true);

    // Verify the FallStep records (3,0)→(6,0) move for the stranded disc
    const fall = steps.slice(clearIdx0 + 1, clearIdx1).find(s => s.kind === StepKind.Fall) as FallStep;
    expect(fall.moves.some(m => m.from.row === 3 && m.to.row === 6 && m.from.col === 0)).toBe(true);
  });
});

// ─── computePushStep ─────────────────────────────────────────────────────────

describe('computePushStep', () => {
  test('push playback is not rewritten by immediate clear resolution', () => {
    const board = buildBoard([at(6, 0, 2)]);
    const { step } = computePushStep(
      board,
      () => makeDisc(7, DiscKind.DoubleCracked),
    );

    computeClearSteps(board);

    expect(step.newRow[0]!.kind).toBe(DiscKind.DoubleCracked);
    expect(board[6]![0]!.kind).toBe(DiscKind.SingleCracked);
    expect(step.newRow[0]).not.toBe(board[6]![0]);
  });

  test('shifts all rows up by one', () => {
    const board = makeEmptyBoard();
    const disc = makeDisc(4, DiscKind.Numbered);
    placeDisc(board, 3, 0, disc);
    computePushStep(board);
    expect(board[2]![0]).toBe(disc); // row 3 → row 2
    expect(board[3]![0]).toBeNull(); // old position is now part of new rows
  });

  test('fills row 6 with 7 cracked discs', () => {
    const { step } = computePushStep(makeEmptyBoard());
    expect(step.kind).toBe(StepKind.Push);
    expect(step.newRow.length).toBe(7);
    for (const disc of step.newRow) {
      expect([DiscKind.SingleCracked, DiscKind.DoubleCracked]).toContain(disc.kind);
    }
  });

  test('gameOver is false when row 0 is empty before the push', () => {
    const board = buildBoard([at(6, 0, 1)]);
    const { gameOver } = computePushStep(board);
    expect(gameOver).toBe(false);
  });

  test('gameOver is true when row 0 has a disc before the push', () => {
    const board = buildBoard([at(0, 3, 5)]);
    const { gameOver } = computePushStep(board);
    expect(gameOver).toBe(true);
  });

  test('gameOver check uses pre-push row 0, not post-push', () => {
    // A disc in row 1 will move to row 0 after the push, but gameOver should
    // reflect the state BEFORE the push — only pre-existing row 0 content matters.
    const board = buildBoard([at(1, 0, 2)]);
    const { gameOver } = computePushStep(board);
    expect(gameOver).toBe(false);
  });
});
