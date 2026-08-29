import {
  defineGameRules,
  defineSoloMode,
  SOLO_ACCOUNT_STATS,
  SOLO_AUTOSAVE,
  SOLO_RUN_SESSION,
} from './mode.js';
import type { GenerationRules, ProgressionRules } from './mode.js';
import {
  ADJACENT_CRACK_REVEAL,
  CLASSIC_ADAPTIVE_GENERATION,
  CLASSIC_CHAIN_SCORING,
  DOWNWARD_DROP,
  ORTHOGONAL_COUNT_MATCH,
  OVERFLOW_OR_FULL_BOARD_ENDS_RUN,
  SEVEN_BY_SEVEN,
} from './modules.js';

// Ration levels are deliberately shorter than Classic's: the band is judged at
// each level end, so a tighter turn budget means more frequent checkpoints, a
// smaller planning horizon, and a shorter window a bad cascade can overshoot.
const RATION_LEVEL_PRESSURE: ProgressionRules = {
  kind: 'level-pressure@1',
  initialTurnsPerLevel: 15,
  turnsPerLevelStep: 1,
  minTurnsPerLevel: 10,
};

// Ration keeps Classic's value/kind balance but deliberately lowers the
// cracked-disc probability: a cracked disc is pure risk here — it cannot be
// deliberately broken, it occupies cells, and clearing adjacent to it reveals
// it into a breakable disc the player did not budget for.
const RATION_GENERATION = {
  ...CLASSIC_ADAPTIVE_GENERATION,
  initialUnnumberedProbability: 0.12,
  unnumberedProbabilityLevelStep: 0.008,
  maxUnnumberedProbability: 0.25,
} as const satisfies GenerationRules;

export const RATION_RULES = defineGameRules({
  id: 'ration',
  version: 1,
  board: SEVEN_BY_SEVEN,
  placement: DOWNWARD_DROP,
  clearing: ORTHOGONAL_COUNT_MATCH,
  revealing: ADJACENT_CRACK_REVEAL,
  generation: RATION_GENERATION,
  scoring: CLASSIC_CHAIN_SCORING,
  progression: RATION_LEVEL_PRESSURE,
  failure: OVERFLOW_OR_FULL_BOARD_ENDS_RUN,
  modifiers: [],
  ration: {
    kind: 'ration-band@1',
    initialBandCenter: 0.92,
    bandCenterLevelStep: 0.05,
    minBandCenter: 0.6,
    bandHalfWidth: 0.11,
    entropyThreshold: 4,
    entropyRecoveryPerLevel: 1,
    entropyMissBase: 1,
    entropyPerDeviationUnit: 0.1,
    maxEntropyGainPerLevel: 3,
    balancedLevelBonus: 2_500,
  },
});

export const RATION_MODE = defineSoloMode({
  kind: 'solo',
  id: 'ration',
  name: 'Ration',
  tagline: 'Clear just enough. No more.',
  hasTutorial: false,
  rules: RATION_RULES,
  session: SOLO_RUN_SESSION,
  persistence: SOLO_AUTOSAVE,
  stats: SOLO_ACCOUNT_STATS,
});
