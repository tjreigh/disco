import { describe, expect, test } from 'vitest';
import { SharedBoardMatch } from '../src/multiplayer/shared-board-match.js';
import type { SharedBoardMatchConfig } from '../src/multiplayer/shared-board-match.js';
import { makeEmptyBoard } from '#game-board';
import { DiscKind } from '#game-model';
import type { Board } from '#game-model';

const TURN_TIMEOUT_MS = 15_000;
const DISRUPTION_THRESHOLD = 3;
const PLAYER_IDS = ['p1', 'p2'] as const;

function createMatch(overrides: Partial<SharedBoardMatchConfig> = {}): SharedBoardMatch {
  return new SharedBoardMatch({
    matchId: 'match-1',
    playerIds: PLAYER_IDS,
    seed: 1,
    turnTimeoutMs: TURN_TIMEOUT_MS,
    disruptionThreshold: DISRUPTION_THRESHOLD,
    ...overrides,
  });
}

/** Every column whose bottom cell is occupied but whose top cell is empty — the exact shape the old bottom-row check misread as "full". */
function bottomRowFullBoard(): Board {
  const board = makeEmptyBoard(7, 7);
  const bottomRow = board.length - 1;
  for (let col = 0; col < board[0]!.length; col++) {
    board[bottomRow]![col] = { id: col, value: (col % 7) + 1, kind: DiscKind.Numbered };
  }
  return board;
}

/**
 * Ground-truth "does any column have room" — a raw scan of every cell in
 * every column, independent of the engine's isColumnFull (or any other
 * helper the fix under test relies on).
 */
function openColumns<T>(board: readonly (readonly (T | null)[])[]): number[] {
  const cols = board[0]?.length ?? 0;
  const open: number[] = [];
  for (let col = 0; col < cols; col++) {
    if (board.some(row => row[col] === null)) open.push(col);
  }
  return open;
}

/** Small deterministic PRNG so a failing fuzz trial is pinnable by seed alone — no unseeded node:crypto anywhere in the trial. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('SharedBoardMatch.expireTurn column selection', () => {
  test('does not report board-full when every column still has room at the top (the exact inversion regression)', () => {
    const match = createMatch();
    match.engine.loadScriptedState({
      board: bottomRowFullBoard(),
      currentDisc: { id: 100, value: 1, kind: DiscKind.Numbered },
      nextDisc: { id: 101, value: 2, kind: DiscKind.Numbered },
    });

    const result = match.expireTurn();

    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.gameOver).toBe(false);
    }
  });

  test('reports board-full once every column truly has no room at the top', () => {
    const match = createMatch();
    const board = makeEmptyBoard(7, 7);
    for (let row = 0; row < board.length; row++) {
      for (let col = 0; col < board[row]!.length; col++) {
        board[row]![col] = { id: row * 7 + col, value: ((row + col) % 7) + 1, kind: DiscKind.Numbered };
      }
    }
    match.engine.loadScriptedState({
      board,
      currentDisc: { id: 200, value: 1, kind: DiscKind.Numbered },
      nextDisc: { id: 201, value: 2, kind: DiscKind.Numbered },
    });

    const result = match.expireTurn();

    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.gameOver).toBe(true);
      expect(result.gameOver && result.gameOverReason).toBe('board-full');
    }
  });

  test('honors an injected pickAvailableColumn instead of the default random pick', () => {
    const match = createMatch({ pickAvailableColumn: (available) => available[2]! });

    const result = match.expireTurn();

    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') expect(result.column).toBe(2);
  });
});

describe('SharedBoardMatch.expireTurn column selection — fuzz', () => {
  test('board-full is only ever reported when the board genuinely has no open column, across many seeded trials', () => {
    for (let trial = 0; trial < 40; trial++) {
      const seed = 1_000 + trial;
      const rng = mulberry32(seed);
      const match = createMatch({
        seed,
        pickAvailableColumn: (available) => available[Math.floor(rng() * available.length)]!,
      });

      let turns = 0;
      while (!match.finished && turns < 400) {
        turns++;
        const useTimeout = rng() < 0.5;
        const result = useTimeout
          ? match.expireTurn()
          : (() => {
            const open = openColumns(match.engine.state.board);
            if (open.length === 0) return match.expireTurn();
            const column = open[Math.floor(rng() * open.length)]!;
            return match.processTurn(match.currentPlayerId, column);
          })();

        expect(result.kind, `seed ${seed}, turn ${turns}`).toBe('accepted');
        if (result.kind !== 'accepted') break;

        if (result.gameOver && result.gameOverReason === 'board-full') {
          expect(openColumns(result.board), `seed ${seed}, turn ${turns}: reported board-full with an open column`)
            .toEqual([]);
        }
        if (result.gameOver) break;
      }

      expect(match.finished, `seed ${seed} never finished within the turn cap`).toBe(true);
    }
  });
});
