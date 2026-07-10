import { describe, test, expect } from 'vitest';
import {
  computeClearSteps, computeDropSteps, computeGravityTiltSteps, computePushStep, pointsForChain,
} from '../../game/physics.js';
import { makeEmptyBoard, placeDisc } from '../../game/board.js';
import { makeDisc } from '../../game/disc.js';
import type { Board } from '../../game/model.js';
import { DiscKind } from '../../game/model.js';
import type { ClearStep, FallStep, RevealStep, DropStep } from '../../game/events.js';
import { StepKind } from '../../game/events.js';
import type { GameModeConfig } from '../../game/modes/mode.js';
import { CLASSIC_MODE, GRAVITY_MODE } from '../../game/modes/index.js';

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
    expect(drop.landPos).toEqual({ row: 6, col: 3 });
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
    expect(drop.landPos.row).toBe(4);
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

  test('an isolated 1 in the middle of the board clears by its horizontal run', () => {
    const board = buildBoard([
      at(4, 3, 1),
      // Supports the 1 vertically while leaving both horizontal neighbors open.
      at(5, 3, 7, DiscKind.DoubleCracked),
      at(6, 3, 7, DiscKind.DoubleCracked),
    ]);

    const steps = computeClearSteps(board);
    const clears = steps.filter(s => s.kind === StepKind.Clear) as ClearStep[];

    expect(clears[0]!.cleared).toContainEqual({ row: 4, col: 3 });
    expect(board[4]![3]).toBeNull();
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
    expect([1, 2, 3, 4, 5, 6].map(n => pointsForChain(n))).toEqual([
      7, 39, 109, 224, 391, 617,
    ]);
    expect(pointsForChain(30)).toBe(34506);
  });

  test('pointsPerDisc and exponent are overridable per mode', () => {
    expect(pointsForChain(3, 1, 1)).toBe(3);
    expect(pointsForChain(2, 10, 2)).toBe(40);
  });

  // Shared board for all four tests below:
  // (3,0) val=2 floats above a gap, isolated (row/col count 1 ≠ 2) so it
  // doesn't self-clear in chain 0.
  // (6,0) val=5 stays: after (6,1)/(6,2) clear it's alone in its row (count 1)
  // and column (count 1), and 5 matches neither.
  // (6,1) and (6,2), both val=1, each alone in their column (count 1 == value)
  // clear in chain 0.
  // Removing them leaves a gap below (3,0); gravity drops it to (5,0), directly
  // on top of (6,0) — a 2-tall column run, matching its value 2 → chain 1.
  function chainBoard(): Board {
    return buildBoard([
      at(3, 0, 2),
      at(6, 0, 5),
      at(6, 1, 1),
      at(6, 2, 1),
    ]);
  }

  // Drop into an isolated column (4) so the dropped disc never touches the
  // (0-2) column group above — it's val=9, never matches its own 1/1 count.
  function dropIsolated(board: Board) {
    return computeDropSteps(board, makeDisc(9, DiscKind.Numbered), 4);
  }

  test('gravity after first clear enables a second clear at higher chain level', () => {
    const steps = dropIsolated(chainBoard());
    const clears = steps.filter(s => s.kind === StepKind.Clear) as ClearStep[];
    expect(clears.length).toBe(2);
    expect(clears[0]!.chainLevel).toBe(0);
    expect(clears[1]!.chainLevel).toBe(1);
  });

  test('scoring: chain 0 awards clearedCount × 7 × 1', () => {
    // 2 discs clear in chain 0: 2 × 7 × 1 = 14
    const steps = dropIsolated(chainBoard());
    const clears = steps.filter(s => s.kind === StepKind.Clear) as ClearStep[];
    expect(clears[0]!.pointsAwarded).toBe(2 * 7 * 1); // 14
  });

  test('scoring: chain 1 awards 39 points per cleared disc', () => {
    const steps = dropIsolated(chainBoard());
    const clears = steps.filter(s => s.kind === StepKind.Clear) as ClearStep[];
    expect(clears[1]!.pointsAwarded).toBe(39);
  });

  test('FallStep appears between the two ClearSteps', () => {
    const steps = dropIsolated(chainBoard());
    const clearIdx0 = steps.findIndex(s => s.kind === StepKind.Clear);
    const clearIdx1 = steps.findLastIndex(s => s.kind === StepKind.Clear);
    const fallBetween = steps
      .slice(clearIdx0 + 1, clearIdx1)
      .some(s => s.kind === StepKind.Fall);
    expect(fallBetween).toBe(true);

    // Verify the FallStep records (3,0)→(5,0) move for the stranded disc
    const fall = steps.slice(clearIdx0 + 1, clearIdx1).find(s => s.kind === StepKind.Fall) as FallStep;
    expect(fall.moves.some(m => m.from.row === 3 && m.to.row === 5 && m.from.col === 0)).toBe(true);
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

    expect(step.newDiscs[0]!.kind).toBe(DiscKind.DoubleCracked);
    expect(board[6]![0]!.kind).toBe(DiscKind.SingleCracked);
    expect(step.newDiscs[0]).not.toBe(board[6]![0]);
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
    expect(step.newDiscs.length).toBe(7);
    for (const disc of step.newDiscs) {
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

  // A push enters from whichever edge gravity currently pulls TOWARD (the
  // "floor" — opposite of where a drop enters), not always the bottom.
  // angleDeg 0 (the default, tested above) is Classic's fixed case; these
  // cover the other 3 cardinal directions a Gravity mode tilt can commit to.
  describe('angle-aware push direction', () => {
    test('180deg (gravity up): enters at row 0, shifts every row down, discards row 6', () => {
      const board = makeEmptyBoard();
      const disc = makeDisc(4, DiscKind.Numbered);
      placeDisc(board, 3, 0, disc);
      const { step } = computePushStep(board, () => makeDisc(7, DiscKind.DoubleCracked), 180);

      expect(step.edge).toBe('top');
      expect(board[4]![0]).toBe(disc); // row 3 -> row 4 (shifted down)
      expect(board[3]![0]).toBeNull();
      expect(board[0]).toEqual(step.newDiscs); // new row entered at the top (step.newDiscs is a clone, see below)
    });

    test('180deg: gameOver is true when row 6 (the drop entry edge) has a disc before the push', () => {
      const board = buildBoard([at(6, 3, 5)]);
      const { gameOver } = computePushStep(board, undefined, 180);
      expect(gameOver).toBe(true);
    });

    test('90deg (gravity right): enters at the rightmost column, shifts every column left, discards column 0', () => {
      const board = makeEmptyBoard();
      const disc = makeDisc(4, DiscKind.Numbered);
      placeDisc(board, 0, 3, disc);
      const { step } = computePushStep(board, () => makeDisc(7, DiscKind.DoubleCracked), 90);

      expect(step.edge).toBe('right');
      expect(board[0]![2]).toBe(disc); // col 3 -> col 2 (shifted left)
      expect(board[0]![3]).toBeNull();
      for (let r = 0; r < board.length; r++) expect(board[r]![6]).toEqual(step.newDiscs[r]);
    });

    test('90deg: gameOver is true when column 0 (the drop entry edge) has a disc before the push', () => {
      const board = buildBoard([at(3, 0, 5)]);
      const { gameOver } = computePushStep(board, undefined, 90);
      expect(gameOver).toBe(true);
    });

    test('270deg (gravity left): enters at column 0, shifts every column right, discards column 6', () => {
      const board = makeEmptyBoard();
      const disc = makeDisc(4, DiscKind.Numbered);
      placeDisc(board, 0, 3, disc);
      const { step } = computePushStep(board, () => makeDisc(7, DiscKind.DoubleCracked), 270);

      expect(step.edge).toBe('left');
      expect(board[0]![4]).toBe(disc); // col 3 -> col 4 (shifted right)
      expect(board[0]![3]).toBeNull();
      for (let r = 0; r < board.length; r++) expect(board[r]![0]).toEqual(step.newDiscs[r]);
    });

    test('270deg: gameOver is true when column 6 (the drop entry edge) has a disc before the push', () => {
      const board = buildBoard([at(3, 6, 5)]);
      const { gameOver } = computePushStep(board, undefined, 270);
      expect(gameOver).toBe(true);
    });

    test('0deg (default) is unchanged: enters at the bottom, edge is "bottom"', () => {
      const { step } = computePushStep(makeEmptyBoard());
      expect(step.edge).toBe('bottom');
    });
  });
});

// ─── Custom GameModeConfig ───────────────────────────────────────────────────
// Proves the mode parameter is actually load-bearing (board size, scoring),
// not just decoratively threaded through, without inventing a real mode.

describe('a non-default GameModeConfig', () => {
  const smallMode: GameModeConfig = {
    ...CLASSIC_MODE,
    id: 'small-test-mode',
    board: { cols: 3, rows: 3 },
    pointsPerDisc: 1,
    chainExponent: 1,
  };

  test('computeDropSteps respects a smaller board size', () => {
    const board = makeEmptyBoard(3, 3);
    const steps = computeDropSteps(board, makeDisc(1, DiscKind.Numbered), 1, smallMode);
    const drop = steps.find(s => s.kind === StepKind.Drop) as DropStep;
    expect(drop.landPos.row).toBe(2); // bottom row of a 3-row board, not 6
  });

  test('computeDropSteps uses the mode scoring constants for clears', () => {
    // 1x1 board column: a lone val=1 disc has row/col run length 1 → clears immediately.
    const board = makeEmptyBoard(3, 3);
    const steps = computeDropSteps(board, makeDisc(1, DiscKind.Numbered), 0, smallMode);
    const clear = steps.find(s => s.kind === StepKind.Clear) as ClearStep;
    // pointsPerDisc=1, exponent=1, chainLength=1 → 1 point per disc, not the classic 7.
    expect(clear.pointsAwarded).toBe(1);
  });
});

// ─── computeGravityTiltSteps – gravity-aware clearing ───────────────────────
// The whole reason Gravity mode's isClearable checks runs along the current
// angle instead of always grid rows/columns: at 45deg, settling packs discs
// into diagonal lines, and a diagonal line is a real "run" to the player
// even though it isn't one to a grid-only rule.

describe('computeGravityTiltSteps – gravity-aware clearing', () => {
  test('a diagonal line clears together at 45deg, which a grid-only rule would miss', () => {
    const board = makeEmptyBoard();
    placeDisc(board, 2, 2, makeDisc(3, DiscKind.Numbered));
    placeDisc(board, 3, 3, makeDisc(3, DiscKind.Numbered));
    placeDisc(board, 4, 4, makeDisc(3, DiscKind.Numbered));

    const steps = computeGravityTiltSteps(board, 45, GRAVITY_MODE);
    const clear = steps.find(s => s.kind === StepKind.Clear) as ClearStep | undefined;

    expect(clear).toBeDefined();
    expect(clear!.cleared).toHaveLength(3);
  });

  test('non-adjacent discs of a matching value do not clear at 0deg — control case', () => {
    const board = makeEmptyBoard();
    // Already resting on the floor, far enough apart that no column/row/
    // diagonal packing at any angle would ever bring them into contact.
    placeDisc(board, 6, 0, makeDisc(3, DiscKind.Numbered));
    placeDisc(board, 6, 3, makeDisc(3, DiscKind.Numbered));
    placeDisc(board, 6, 6, makeDisc(3, DiscKind.Numbered));

    const steps = computeGravityTiltSteps(board, 0, GRAVITY_MODE);
    const clear = steps.find(s => s.kind === StepKind.Clear);

    expect(clear).toBeUndefined();
  });
});
