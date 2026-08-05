import { describe, test, expect } from 'vitest';
import {
  parseMultiplayerClientMessage,
  parseMultiplayerServerMessage,
} from '../../shared/multiplayer-messages.js';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  multiplayerModeIdentity,
} from '../../shared/multiplayer-contracts.js';
import type { TurnResultWire, WireBoard } from '../../shared/multiplayer-contracts.js';
import { SHARED_DUEL_MODE } from '../../game/modes/index.js';

const mode = multiplayerModeIdentity(SHARED_DUEL_MODE);
const base = { protocolVersion: MULTIPLAYER_PROTOCOL_VERSION, roomId: 'ROOM1' };

function emptyBoard(): WireBoard {
  return Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => null));
}

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
    });
    expect(result.ok).toBe(true);
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
    });
    expect(result.ok).toBe(true);
  });
});
