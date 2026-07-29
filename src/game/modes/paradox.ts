import {
  defineGameRules,
  defineSoloMode,
  SOLO_ACCOUNT_STATS,
  SOLO_AUTOSAVE,
  SOLO_RUN_SESSION,
} from './mode.js';
import {
  ADJACENT_CRACK_REVEAL,
  CLASSIC_ADAPTIVE_GENERATION,
  CLASSIC_CHAIN_SCORING,
  CLASSIC_LEVEL_PRESSURE,
  DOWNWARD_DROP,
  ORTHOGONAL_COUNT_MATCH,
  OVERFLOW_OR_FULL_BOARD_ENDS_RUN,
  PARADOX_REWIND,
  SEVEN_BY_SEVEN,
} from './modules.js';

export const PARADOX_RULES = defineGameRules({
  id: 'paradox',
  version: 1,
  board: SEVEN_BY_SEVEN,
  placement: DOWNWARD_DROP,
  clearing: ORTHOGONAL_COUNT_MATCH,
  revealing: ADJACENT_CRACK_REVEAL,
  generation: CLASSIC_ADAPTIVE_GENERATION,
  scoring: CLASSIC_CHAIN_SCORING,
  progression: CLASSIC_LEVEL_PRESSURE,
  failure: OVERFLOW_OR_FULL_BOARD_ENDS_RUN,
  modifiers: [PARADOX_REWIND],
});

export const PARADOX_MODE = defineSoloMode({
  kind: 'solo',
  id: 'paradox',
  name: 'Paradox',
  tagline: 'Rewind your mistakes, but every erased turn fractures the board.',
  hasTutorial: false,
  rules: PARADOX_RULES,
  session: SOLO_RUN_SESSION,
  persistence: SOLO_AUTOSAVE,
  stats: SOLO_ACCOUNT_STATS,
});
