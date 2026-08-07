import { describe, test, expect } from 'vitest';
import {
  parseMultiplayerClientMessage,
  parseMultiplayerServerMessage,
} from '../../shared/multiplayer-messages.js';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  multiplayerModeIdentity,
} from '../../shared/multiplayer-contracts.js';
import type { TurnResultWire, WireBoard, WireDisc } from '../../shared/multiplayer-contracts.js';
import { SHARED_DUEL_MODE } from '../../game/modes/index.js';

const mode = multiplayerModeIdentity(SHARED_DUEL_MODE);
const base = { protocolVersion: MULTIPLAYER_PROTOCOL_VERSION, roomId: 'ROOM1' };

function emptyBoard(): WireBoard {
  return Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => null));
}

const currentDisc: WireDisc = { id: 201, value: 4, kind: 'numbered' };
const nextDisc: WireDisc = { id: 202, value: 6, kind: 'numbered' };
const discFields = {
  currentDisc,
  nextDisc,
  level: 1,
  turnsPerLevel: 7,
  turnsRemaining: 5,
};

describe('play-turn client message', () => {
  test('parses a valid drop', () => {
    const result = parseMultiplayerClientMessage({
      ...base, playerId: 'p1', type: 'play-turn', matchId: 'match-1', column: 3,
    });
    expect(result).toEqual({
      ok: true,
      message: { ...base, playerId: 'p1', type: 'play-turn', matchId: 'match-1', column: 3 },
    });
  });

  test('rejects a column outside the board', () => {
    const result = parseMultiplayerClientMessage({
      ...base, playerId: 'p1', type: 'play-turn', matchId: 'match-1', column: 7,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });
});

describe('move-cursor client message', () => {
  test('parses a valid cursor move', () => {
    const result = parseMultiplayerClientMessage({
      ...base, playerId: 'p1', type: 'move-cursor', matchId: 'match-1', column: 5,
    });
    expect(result).toEqual({
      ok: true,
      message: { ...base, playerId: 'p1', type: 'move-cursor', matchId: 'match-1', column: 5 },
    });
  });

  test('rejects a column outside the board', () => {
    const result = parseMultiplayerClientMessage({
      ...base, playerId: 'p1', type: 'move-cursor', matchId: 'match-1', column: -1,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });
});

describe('set-paused client message', () => {
  test('parses a valid pause request', () => {
    const result = parseMultiplayerClientMessage({
      ...base, playerId: 'p1', type: 'set-paused', matchId: 'match-1', paused: true,
    });
    expect(result).toEqual({
      ok: true,
      message: { ...base, playerId: 'p1', type: 'set-paused', matchId: 'match-1', paused: true },
    });
  });

  test('parses a valid resume request', () => {
    const result = parseMultiplayerClientMessage({
      ...base, playerId: 'p1', type: 'set-paused', matchId: 'match-1', paused: false,
    });
    expect(result.ok).toBe(true);
  });

  test('rejects a non-boolean paused field', () => {
    const result = parseMultiplayerClientMessage({
      ...base, playerId: 'p1', type: 'set-paused', matchId: 'match-1', paused: 'true',
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects extra keys', () => {
    const result = parseMultiplayerClientMessage({
      ...base, playerId: 'p1', type: 'set-paused', matchId: 'match-1', paused: true, extra: 1,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });
});

describe('forfeit-match client message', () => {
  test('parses a valid forfeit', () => {
    const result = parseMultiplayerClientMessage({
      ...base, playerId: 'p1', type: 'forfeit-match', matchId: 'match-1',
    });
    expect(result).toEqual({
      ok: true,
      message: { ...base, playerId: 'p1', type: 'forfeit-match', matchId: 'match-1' },
    });
  });

  test('rejects a missing matchId', () => {
    const result = parseMultiplayerClientMessage({
      ...base, playerId: 'p1', type: 'forfeit-match',
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });
});

describe('match-paused server message', () => {
  test('parses a valid pause broadcast', () => {
    const result = parseMultiplayerServerMessage({
      ...base, mode, type: 'match-paused', matchId: 'match-1', paused: true, pausedBy: 'p1', deadline: 15_000,
    });
    expect(result).toEqual({
      ok: true,
      message: {
        ...base, mode, type: 'match-paused', matchId: 'match-1', paused: true, pausedBy: 'p1', deadline: 15_000,
      },
    });
  });

  test('parses a valid resume broadcast with a shifted deadline', () => {
    const result = parseMultiplayerServerMessage({
      ...base, mode, type: 'match-paused', matchId: 'match-1', paused: false, pausedBy: 'p1', deadline: 20_000,
    });
    expect(result.ok).toBe(true);
  });

  test('rejects a missing pausedBy', () => {
    const result = parseMultiplayerServerMessage({
      ...base, mode, type: 'match-paused', matchId: 'match-1', paused: true, deadline: 15_000,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a negative deadline', () => {
    const result = parseMultiplayerServerMessage({
      ...base, mode, type: 'match-paused', matchId: 'match-1', paused: true, pausedBy: 'p1', deadline: -1,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });
});

describe('match-finished server message', () => {
  test('parses a result where the winner matches the higher score', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'match-finished',
      matchId: 'match-1',
      result: {
        winnerId: 'p1',
        scores: [{ playerId: 'p1', score: 200 }, { playerId: 'p2', score: 100 }],
        forfeitedBy: null,
      },
    });
    expect(result.ok).toBe(true);
  });

  test('parses a null winnerId for a genuine tie', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'match-finished',
      matchId: 'match-1',
      result: {
        winnerId: null,
        scores: [{ playerId: 'p1', score: 100 }, { playerId: 'p2', score: 100 }],
        forfeitedBy: null,
      },
    });
    expect(result.ok).toBe(true);
  });

  // Regression: a forfeit forces the non-forfeiting player as winner
  // regardless of the score at the moment of forfeit (see forfeitMatch in
  // both room services) — this must still parse even though the winner
  // does not have the higher score, or the forfeit result gets rejected
  // by both clients as "The server sent a message this client couldn't
  // understand."
  test('parses a forfeit result where the winner does not have the higher score', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'match-finished',
      matchId: 'match-1',
      result: {
        winnerId: 'p2',
        scores: [{ playerId: 'p1', score: 500 }, { playerId: 'p2', score: 10 }],
        forfeitedBy: 'p1',
      },
    });
    expect(result.ok).toBe(true);
  });

  test('rejects a winnerId that names neither player', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'match-finished',
      matchId: 'match-1',
      result: {
        winnerId: 'someone-else',
        scores: [{ playerId: 'p1', score: 100 }, { playerId: 'p2', score: 50 }],
        forfeitedBy: null,
      },
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a forfeit whose winner is the forfeiter themselves', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'match-finished',
      matchId: 'match-1',
      result: {
        winnerId: 'p1',
        scores: [{ playerId: 'p1', score: 500 }, { playerId: 'p2', score: 10 }],
        forfeitedBy: 'p1',
      },
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a forfeit result that claims a tie', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'match-finished',
      matchId: 'match-1',
      result: {
        winnerId: null,
        scores: [{ playerId: 'p1', score: 500 }, { playerId: 'p2', score: 500 }],
        forfeitedBy: 'p1',
      },
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });
});

describe('opponent-cursor server message', () => {
  test('parses a valid broadcast', () => {
    const result = parseMultiplayerServerMessage({
      ...base, mode, type: 'opponent-cursor', matchId: 'match-1', playerId: 'p1', column: 2,
    });
    expect(result).toEqual({
      ok: true,
      message: { ...base, mode, type: 'opponent-cursor', matchId: 'match-1', playerId: 'p1', column: 2 },
    });
  });

  test('rejects a missing playerId', () => {
    const result = parseMultiplayerServerMessage({
      ...base, mode, type: 'opponent-cursor', matchId: 'match-1', column: 2,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });
});

describe('match-countdown server message', () => {
  // Regression: Score Race's deadline is startsAt + a real match duration
  // (always strictly later), but shared-board-duel has no fixed match
  // duration and reuses deadline === startsAt (SharedBoardRoomService
  // .countdownMessage). A parser that required deadline > startsAt rejected
  // every shared-duel match-countdown message outright.
  test('accepts deadline equal to startsAt (shared-board-duel has no match duration)', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'match-countdown',
      matchId: 'match-1',
      startsAt: 1_000,
      deadline: 1_000,
      seed: 1,
    });
    expect(result.ok).toBe(true);
  });

  test('still rejects a deadline before startsAt', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'match-countdown',
      matchId: 'match-1',
      startsAt: 1_000,
      deadline: 999,
      seed: 1,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });
});

describe('turn-assigned server message', () => {
  test('parses a valid assignment', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'p1',
      turnDeadline: 15_000,
      board: emptyBoard(),
      revision: 0,
      ...discFields,
    });
    expect(result).toEqual({
      ok: true,
      message: {
        ...base,
        mode,
        type: 'turn-assigned',
        matchId: 'match-1',
        playerId: 'p1',
        turnDeadline: 15_000,
        board: emptyBoard(),
        revision: 0,
        ...discFields,
      },
    });
  });

  test('rejects a message missing the current-disc preview fields', () => {
    const { currentDisc: _currentDisc, ...rest } = discFields;
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'p1',
      turnDeadline: 15_000,
      board: emptyBoard(),
      revision: 0,
      ...rest,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a malformed nextDisc', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'p1',
      turnDeadline: 15_000,
      board: emptyBoard(),
      revision: 0,
      ...discFields,
      nextDisc: { id: 203, value: 0, kind: 'numbered' },
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a non-positive level', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'p1',
      turnDeadline: 15_000,
      board: emptyBoard(),
      revision: 0,
      ...discFields,
      level: 0,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  // turnsRemaining legitimately reaches 0 on the message that ends a match
  // mid-level (see engine.ts: the turnsPerLevel reset on level-complete is
  // skipped when that same turn is also game-over) — 0 must parse.
  test('accepts turnsRemaining of 0', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'p1',
      turnDeadline: 15_000,
      board: emptyBoard(),
      revision: 0,
      ...discFields,
      turnsRemaining: 0,
    });
    expect(result.ok).toBe(true);
  });

  // Revision ties this message to a duel-status pulse describing the same
  // state (see docs/fix-duel-sync-resilience-plan.md section 1) — a client
  // can no longer infer it, so a missing or invalid one must be rejected.
  test('rejects a missing revision', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'p1',
      turnDeadline: 15_000,
      board: emptyBoard(),
      ...discFields,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a negative revision', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'p1',
      turnDeadline: 15_000,
      board: emptyBoard(),
      revision: -1,
      ...discFields,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });
});

describe('turn-played server message', () => {
  const turnResult: TurnResultWire = {
    playerId: 'p1',
    column: 3,
    triggerScoreDelta: 100,
    opponentScoreDelta: 0,
    stackSize: 1,
    gameOver: false,
    steps: [
      {
        kind: 'drop',
        disc: { id: 42, value: 5, kind: 'numbered', ownerId: 'p1' },
        // entryPos.row is -1 by design: the off-board start position one
        // cell above the entry edge (see physics.ts computeDropSteps).
        entryPos: { row: -1, col: 3 },
        landPos: { row: 6, col: 3 },
      },
    ],
  };

  test('parses a drop step whose entryPos sits one row above the board', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'turn-played',
      matchId: 'match-1',
      board: emptyBoard(),
      turnResult,
      nextPlayerId: 'p2',
      revision: 1,
      ...discFields,
    });
    expect(result).toEqual({
      ok: true,
      message: {
        ...base,
        mode,
        type: 'turn-played',
        matchId: 'match-1',
        board: emptyBoard(),
        turnResult,
        nextPlayerId: 'p2',
        revision: 1,
        ...discFields,
      },
    });
  });

  test('rejects a disc missing a stable id', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'turn-played',
      matchId: 'match-1',
      board: emptyBoard(),
      turnResult: {
        ...turnResult,
        steps: [{
          kind: 'drop',
          disc: { value: 5, kind: 'numbered' },
          entryPos: { row: -1, col: 3 },
          landPos: { row: 6, col: 3 },
        }],
      },
      nextPlayerId: 'p2',
      revision: 1,
      ...discFields,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a disc value outside the 1-7 range', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'turn-played',
      matchId: 'match-1',
      board: emptyBoard(),
      turnResult: {
        ...turnResult,
        steps: [{
          kind: 'drop',
          disc: { id: 1, value: 8, kind: 'numbered' },
          entryPos: { row: -1, col: 3 },
          landPos: { row: 6, col: 3 },
        }],
      },
      nextPlayerId: 'p2',
      revision: 1,
      ...discFields,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('accepts a null column when the timer expired with no available move', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'turn-expired',
      matchId: 'match-1',
      board: emptyBoard(),
      turnResult: {
        ...turnResult,
        column: null,
        steps: [],
        gameOver: true,
        gameOverReason: 'board-full',
      },
      nextPlayerId: 'p2',
      revision: 1,
      ...discFields,
      turnsRemaining: 0,
    });
    expect(result.ok).toBe(true);
  });

  test('rejects a turn-played missing the level/turn-budget fields', () => {
    const { level: _level, ...rest } = discFields;
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'turn-played',
      matchId: 'match-1',
      board: emptyBoard(),
      turnResult,
      nextPlayerId: 'p2',
      revision: 1,
      ...rest,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a missing revision', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'turn-played',
      matchId: 'match-1',
      board: emptyBoard(),
      turnResult,
      nextPlayerId: 'p2',
      ...discFields,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a negative revision', () => {
    const result = parseMultiplayerServerMessage({
      ...base,
      mode,
      type: 'turn-expired',
      matchId: 'match-1',
      board: emptyBoard(),
      turnResult,
      nextPlayerId: 'p2',
      revision: -1,
      ...discFields,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });
});

describe('duel-status server message', () => {
  const scores = [
    { playerId: 'p1', score: 120 },
    { playerId: 'p2', score: 80 },
  ];

  function payload(overrides: Record<string, unknown> = {}) {
    return {
      ...base,
      mode,
      type: 'duel-status',
      matchId: 'match-1',
      revision: 2,
      serverTime: 5_000,
      activePlayerId: 'p1',
      turnDeadline: 20_000,
      activeColumn: 3,
      paused: false,
      pausedBy: null,
      scores,
      board: emptyBoard(),
      currentDisc,
      nextDisc,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 5,
      ...overrides,
    };
  }

  test('parses a valid unpaused status', () => {
    const result = parseMultiplayerServerMessage(payload());
    expect(result).toEqual({ ok: true, message: payload() });
  });

  test('parses a valid paused status', () => {
    const result = parseMultiplayerServerMessage(payload({ paused: true, pausedBy: 'p1' }));
    expect(result.ok).toBe(true);
  });

  test('rejects paused true with a null pausedBy', () => {
    const result = parseMultiplayerServerMessage(payload({ paused: true, pausedBy: null }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects paused false with a non-null pausedBy', () => {
    const result = parseMultiplayerServerMessage(payload({ paused: false, pausedBy: 'p1' }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a pausedBy outside the authoritative score pair', () => {
    const result = parseMultiplayerServerMessage(payload({ paused: true, pausedBy: 'someone-else' }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a negative revision', () => {
    const result = parseMultiplayerServerMessage(payload({ revision: -1 }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a negative serverTime', () => {
    const result = parseMultiplayerServerMessage(payload({ serverTime: -1 }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a negative turnDeadline', () => {
    const result = parseMultiplayerServerMessage(payload({ turnDeadline: -1 }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a cursor column outside 0-6', () => {
    const result = parseMultiplayerServerMessage(payload({ activeColumn: 7 }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects duplicate score player IDs', () => {
    const result = parseMultiplayerServerMessage(payload({
      scores: [{ playerId: 'p1', score: 100 }, { playerId: 'p1', score: 50 }],
    }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a negative score', () => {
    const result = parseMultiplayerServerMessage(payload({
      scores: [{ playerId: 'p1', score: -1 }, { playerId: 'p2', score: 50 }],
    }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects an activePlayerId outside the score pair', () => {
    const result = parseMultiplayerServerMessage(payload({ activePlayerId: 'someone-else' }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a board that is not exactly 7 rows', () => {
    const result = parseMultiplayerServerMessage(payload({
      board: Array.from({ length: 6 }, () => Array.from({ length: 7 }, () => null)),
    }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a ragged board row', () => {
    const board = emptyBoard();
    board[0] = Array.from({ length: 6 }, () => null);
    const result = parseMultiplayerServerMessage(payload({ board }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects an empty board', () => {
    const result = parseMultiplayerServerMessage(payload({ board: [] }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a malformed disc on the board', () => {
    const board = emptyBoard();
    board[0]![0] = { id: 1, value: 9, kind: 'numbered' } as never;
    const result = parseMultiplayerServerMessage(payload({ board }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects extra unknown fields', () => {
    const result = parseMultiplayerServerMessage(payload({ extra: 'nope' }));
    expect(result).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('rejects a protocol-version mismatch', () => {
    const result = parseMultiplayerServerMessage(payload({ protocolVersion: MULTIPLAYER_PROTOCOL_VERSION + 1 }));
    expect(result).toEqual({ ok: false, error: 'protocol-mismatch' });
  });
});
