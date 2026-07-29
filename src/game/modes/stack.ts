import {
  defineGameRules,
  defineSoloMode,
  SOLO_ACCOUNT_STATS,
  SOLO_AUTOSAVE,
  SOLO_RUN_SESSION,
} from './mode.js';
import {
  ADJACENT_CRACK_REVEAL,
  DOWNWARD_DROP,
  ORTHOGONAL_COUNT_MATCH,
  SEVEN_BY_SEVEN,
  STACK_ADAPTIVE_GENERATION,
  STACK_LEVEL_PRESSURE,
  STACK_SCORING,
  OVERFLOW_OR_FULL_BOARD_ENDS_RUN,
} from './modules.js';

export const STACK_RULES = defineGameRules({
  id: 'stack',
  version: 1,
  board: SEVEN_BY_SEVEN,
  placement: DOWNWARD_DROP,
  clearing: ORTHOGONAL_COUNT_MATCH,
  revealing: ADJACENT_CRACK_REVEAL,
  generation: STACK_ADAPTIVE_GENERATION,
  scoring: STACK_SCORING,
  progression: STACK_LEVEL_PRESSURE,
  failure: OVERFLOW_OR_FULL_BOARD_ENDS_RUN,
  modifiers: [],
});

export const STACK_MODE = defineSoloMode({
  kind: 'solo',
  id: 'stack',
  name: 'Stack',
  tagline: 'One drop, one cascade—the more discs it clears, the bigger the payoff.',
  hasTutorial: true,
  rules: STACK_RULES,
  session: SOLO_RUN_SESSION,
  persistence: SOLO_AUTOSAVE,
  stats: SOLO_ACCOUNT_STATS,
});
