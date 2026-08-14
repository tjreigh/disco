import {
  defineGameRules,
  defineMultiplayerMode,
} from './mode.js';
import {
  ADJACENT_CRACK_REVEAL,
  CLASSIC_CHAIN_SCORING,
  CLASSIC_LEVEL_PRESSURE,
  DOWNWARD_DROP,
  ORTHOGONAL_COUNT_MATCH,
  OVERFLOW_OR_FULL_BOARD_ENDS_RUN,
  SCORE_RACE_HISTORY_GENERATION,
  SEVEN_BY_SEVEN,
} from './modules.js';

// Intentionally not imported from src/shared/multiplayer-contracts.ts,
// which independently declares the same four values: api/tsconfig.game.json
// compiles src/game in isolation (rootDir "../src/game") and rejects a raw
// relative import that crosses into src/shared. See
// src/test/game/modes.test.ts's "multiplayer mode identity stays in sync
// with the wire protocol constants" describe block for the test that keeps
// the two copies in sync.
const SCORE_RACE_MODE_ID = 'score-race' as const;
const SCORE_RACE_MODE_VERSION = 1 as const;
const SCORE_RACE_RULES_VERSION = 1 as const;
const SCORE_RACE_DURATION_MS = 180_000;

export const SCORE_RACE_RULES = defineGameRules({
  id: SCORE_RACE_MODE_ID,
  version: SCORE_RACE_RULES_VERSION,
  board: SEVEN_BY_SEVEN,
  placement: DOWNWARD_DROP,
  clearing: ORTHOGONAL_COUNT_MATCH,
  revealing: ADJACENT_CRACK_REVEAL,
  generation: SCORE_RACE_HISTORY_GENERATION,
  scoring: CLASSIC_CHAIN_SCORING,
  progression: CLASSIC_LEVEL_PRESSURE,
  failure: OVERFLOW_OR_FULL_BOARD_ENDS_RUN,
  modifiers: [],
});

export const SCORE_RACE_MODE = defineMultiplayerMode({
  kind: 'multiplayer',
  id: SCORE_RACE_MODE_ID,
  version: SCORE_RACE_MODE_VERSION,
  name: 'Score Race',
  tagline: 'Three minutes. Same discs. Highest score wins.',
  rules: SCORE_RACE_RULES,
  session: {
    kind: 'timed-score-race@1',
    durationMs: SCORE_RACE_DURATION_MS,
    fairness: { kind: 'identical-sequence' },
    result: {
      kind: 'highest-score-wins@1',
      tie: 'tie',
    },
  },
});
