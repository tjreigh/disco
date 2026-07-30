import { describe, expect, test } from 'vitest';
import {
  determineScoreRaceResult,
  MULTIPLAYER_PROTOCOL_VERSION,
  rulesIdentity,
  SCORE_RACE_MODE_ID,
  SCORE_RACE_RULES_VERSION,
  sameRulesIdentity,
} from '../../src/shared/multiplayer-contracts.js';

describe('shared multiplayer contracts', () => {
  test('the API consumes the same protocol and rules identity source as the browser', () => {
    expect(MULTIPLAYER_PROTOCOL_VERSION).toBe(1);
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
    expect(determineScoreRaceResult('local', 700, 'opponent', 500)).toEqual({
      outcome: 'win',
      winnerId: 'local',
      localScore: 700,
      opponentScore: 500,
    });
    expect(determineScoreRaceResult('local', 500, 'opponent', 500)).toEqual({
      outcome: 'tie',
      winnerId: null,
      localScore: 500,
      opponentScore: 500,
    });
  });
});
