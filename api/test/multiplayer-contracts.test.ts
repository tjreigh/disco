import { describe, expect, test } from 'vitest';
import {
  determineScoreRaceResult,
  localizeMultiplayerResult,
  multiplayerModeIdentity,
  MULTIPLAYER_PROTOCOL_VERSION,
  parseMultiplayerClientMessage,
  parseMultiplayerServerMessage,
  rulesIdentity,
  SCORE_RACE_DURATION_MS,
  SCORE_RACE_MODE_ID,
  SCORE_RACE_MODE_VERSION,
  SCORE_RACE_RULES_VERSION,
  sameRulesIdentity,
} from '../src/multiplayer/contracts.js';

describe('shared multiplayer contracts', () => {
  test('the API consumes the same protocol and rules identity source as the browser', () => {
    expect(MULTIPLAYER_PROTOCOL_VERSION).toBe(4);
    expect(SCORE_RACE_DURATION_MS).toBe(180_000);
    expect(rulesIdentity({
      id: SCORE_RACE_MODE_ID,
      version: SCORE_RACE_RULES_VERSION,
    })).toEqual({
      id: 'score-race',
      version: 1,
    });
    expect(sameRulesIdentity(
      { id: 'score-race', version: 1 },
      { id: 'score-race', version: 2 },
    )).toBe(false);
  });

  test('highest score wins and exact score equality is a tie', () => {
    const win = determineScoreRaceResult('local', 700, 'opponent', 500);
    expect(win).toEqual({
      winnerId: 'local',
      scores: [
        { playerId: 'local', score: 700 },
        { playerId: 'opponent', score: 500 },
      ],
      forfeitedBy: null,
    });
    expect(determineScoreRaceResult('local', 500, 'opponent', 500)).toEqual({
      winnerId: null,
      scores: [
        { playerId: 'local', score: 500 },
        { playerId: 'opponent', score: 500 },
      ],
      forfeitedBy: null,
    });
    expect(localizeMultiplayerResult(win, 'opponent')).toEqual({
      outcome: 'loss',
      localScore: 500,
      opponentScore: 700,
      forfeitedBy: null,
    });
  });

  test('parses canonical wire messages and rejects malformed or contradictory data', () => {
    const mode = multiplayerModeIdentity({
      id: SCORE_RACE_MODE_ID,
      version: SCORE_RACE_MODE_VERSION,
      rules: {
        id: SCORE_RACE_MODE_ID,
        version: SCORE_RACE_RULES_VERSION,
      },
    });
    expect(parseMultiplayerClientMessage({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: 'ROOM1',
      playerId: 'player-1',
      type: 'publish-progress',
      matchId: 'match-1',
      progress: { sequence: 1, score: 700, turnsPlayed: 2 },
    }).ok).toBe(true);
    // A forfeit forces the non-forfeiting player as winner regardless of
    // score (see forfeitMatch in both room services) — the parser must
    // accept a winner that doesn't have the higher score, or every forfeit
    // gets rejected by both clients as an incompatible/malformed message.
    expect(parseMultiplayerServerMessage({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: 'ROOM1',
      mode,
      type: 'match-finished',
      matchId: 'match-1',
      result: {
        winnerId: 'player-2',
        scores: [
          { playerId: 'player-1', score: 700 },
          { playerId: 'player-2', score: 500 },
        ],
        forfeitedBy: 'player-1',
      },
    }).ok).toBe(true);
    // Still rejected: a winnerId that doesn't name either participant.
    expect(parseMultiplayerServerMessage({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: 'ROOM1',
      mode,
      type: 'match-finished',
      matchId: 'match-1',
      result: {
        winnerId: 'someone-else',
        scores: [
          { playerId: 'player-1', score: 700 },
          { playerId: 'player-2', score: 500 },
        ],
        forfeitedBy: null,
      },
    })).toEqual({ ok: false, error: 'invalid-message' });
    expect(parseMultiplayerClientMessage({
      protocolVersion: 99,
      roomId: 'ROOM1',
      playerId: 'player-1',
      type: 'set-ready',
      ready: true,
    })).toEqual({ ok: false, error: 'protocol-mismatch' });
  });
});
