import {
  SCORE_RACE_MODE_ID,
  SCORE_RACE_MODE_VERSION,
  SCORE_RACE_RULES_VERSION,
} from '../../shared/multiplayer-contracts.js';
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
    durationMs: 3 * 60 * 1_000,
    fairness: { kind: 'identical-sequence' },
    result: {
      kind: 'highest-score-wins@1',
      tie: 'tie',
    },
  },
});
