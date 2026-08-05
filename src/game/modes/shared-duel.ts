import {
  SHARED_DUEL_DISRUPTION_THRESHOLD,
  SHARED_DUEL_MODE_ID,
  SHARED_DUEL_MODE_VERSION,
  SHARED_DUEL_RULES_VERSION,
  SHARED_DUEL_TURN_TIMEOUT_MS,
} from '../../shared/multiplayer-contracts.js';
import {
  defineGameRules,
  defineMultiplayerMode,
} from './mode.js';
import {
  ADJACENT_CRACK_REVEAL,
  CLASSIC_ADAPTIVE_GENERATION,
  CLASSIC_CHAIN_SCORING,
  CLASSIC_LEVEL_PRESSURE,
  DOWNWARD_DROP,
  ORTHOGONAL_COUNT_MATCH,
  OVERFLOW_OR_FULL_BOARD_ENDS_RUN,
  SEVEN_BY_SEVEN,
} from './modules.js';

export const SHARED_DUEL_RULES = defineGameRules({
  id: SHARED_DUEL_MODE_ID,
  version: SHARED_DUEL_RULES_VERSION,
  board: SEVEN_BY_SEVEN,
  placement: DOWNWARD_DROP,
  clearing: ORTHOGONAL_COUNT_MATCH,
  revealing: ADJACENT_CRACK_REVEAL,
  generation: CLASSIC_ADAPTIVE_GENERATION,
  scoring: CLASSIC_CHAIN_SCORING,
  progression: CLASSIC_LEVEL_PRESSURE,
  failure: OVERFLOW_OR_FULL_BOARD_ENDS_RUN,
  modifiers: [],
});

export const SHARED_DUEL_MODE = defineMultiplayerMode({
  kind: 'multiplayer',
  id: SHARED_DUEL_MODE_ID,
  version: SHARED_DUEL_MODE_VERSION,
  name: 'Disco Duel',
  tagline: 'Same board. Alternating turns. Clear, steal, win.',
  rules: SHARED_DUEL_RULES,
  session: {
    kind: 'shared-board-duel@1',
    turnTimeoutMs: SHARED_DUEL_TURN_TIMEOUT_MS,
    disruptionThreshold: SHARED_DUEL_DISRUPTION_THRESHOLD,
    fairness: { kind: 'shared-board-seeded' },
    result: {
      kind: 'highest-score-wins@1',
      tie: 'tie',
    },
  },
});
