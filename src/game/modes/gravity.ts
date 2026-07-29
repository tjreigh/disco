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
  GRAVITY_ALIGNED_COUNT_MATCH,
  OVERFLOW_OR_FULL_BOARD_ENDS_RUN,
  SEVEN_BY_SEVEN,
  STAGE_AND_TILT,
} from './modules.js';

export const GRAVITY_RULES = defineGameRules({
  id: 'gravity',
  version: 1,
  board: SEVEN_BY_SEVEN,
  placement: STAGE_AND_TILT,
  clearing: GRAVITY_ALIGNED_COUNT_MATCH,
  revealing: ADJACENT_CRACK_REVEAL,
  generation: CLASSIC_ADAPTIVE_GENERATION,
  scoring: CLASSIC_CHAIN_SCORING,
  progression: CLASSIC_LEVEL_PRESSURE,
  failure: OVERFLOW_OR_FULL_BOARD_ENDS_RUN,
  modifiers: [],
});

export const GRAVITY_MODE = defineSoloMode({
  kind: 'solo',
  id: 'gravity',
  name: 'Gravity',
  tagline: 'Stage each drop, then tilt gravity to settle the board.',
  hasTutorial: true,
  rules: GRAVITY_RULES,
  session: SOLO_RUN_SESSION,
  persistence: SOLO_AUTOSAVE,
  stats: SOLO_ACCOUNT_STATS,
});
