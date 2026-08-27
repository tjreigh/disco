import {
  defineGameRules,
  defineSoloMode,
  SOLO_ACCOUNT_STATS,
  SOLO_AUTOSAVE,
  SOLO_RUN_SESSION,
} from './mode.js';
import type { GenerationRules } from './mode.js';
import {
  ADJACENT_CRACK_REVEAL,
  CLASSIC_ADAPTIVE_GENERATION,
  CLASSIC_CHAIN_SCORING,
  CLASSIC_LEVEL_PRESSURE,
  DOWNWARD_DROP,
  ORTHOGONAL_COUNT_MATCH,
  SEVEN_BY_SEVEN,
  OVERFLOW_OR_FULL_BOARD_ENDS_RUN,
} from './modules.js';

// Classic ramps hazards more gently than its adjacent modes. A softer history
// correction leaves the queue varied while the two-disc run cap prevents
// unplayable X-disc streaks.
const CLASSIC_TUNED_GENERATION = {
  ...CLASSIC_ADAPTIVE_GENERATION,
  unnumberedProbabilityLevelStep: 0.004,
  maxUnnumberedProbability: 0.32,
  kindBalanceStrength: 0.7,
} as const satisfies GenerationRules;

export const CLASSIC_RULES = defineGameRules({
  id: 'classic',
  version: 1,
  board: SEVEN_BY_SEVEN,
  placement: DOWNWARD_DROP,
  clearing: ORTHOGONAL_COUNT_MATCH,
  revealing: ADJACENT_CRACK_REVEAL,
  generation: CLASSIC_TUNED_GENERATION,
  scoring: CLASSIC_CHAIN_SCORING,
  progression: CLASSIC_LEVEL_PRESSURE,
  failure: OVERFLOW_OR_FULL_BOARD_ENDS_RUN,
  modifiers: [],
});

export const CLASSIC_MODE = defineSoloMode({
  kind: 'solo',
  id: 'classic',
  name: 'Classic',
  tagline: 'The original 7×7 Drop7 experience.',
  hasTutorial: true,
  rules: CLASSIC_RULES,
  session: SOLO_RUN_SESSION,
  persistence: SOLO_AUTOSAVE,
  stats: SOLO_ACCOUNT_STATS,
});
