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

// Ration keeps short levels for its board pushes and planning rhythm. Balance
// is judged independently on a rolling ledger, so a level-end cascade cannot
// make a whole level irrecoverable by itself.
//
// The band is flat and centered above one break per drop on purpose: every
// level adds a full pushed row on top of the drops themselves, so a player
// who only breaks about one disc per drop still sees the board grow each
// level. Simulated play showed the old descending 0.85-center band failing
// players well before the board did.
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
  initialUnnumberedProbability: 0.06,
  unnumberedProbabilityLevelStep: 0.004,
  maxUnnumberedProbability: 0.15,
} as const satisfies GenerationRules;

export const RATION_RULES = defineGameRules({
  id: 'ration',
  version: 3,
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
    initialBandCenter: 1.3,
    bandCenterLevelStep: 0,
    minBandCenter: 1.3,
    bandHalfWidth: 0.3,
    rollingWindowDrops: 12,
    // Judging every half window keeps one mistake from failing several
    // overlapping checkpoints in a row.
    checkpointDrops: 6,
    entropyThreshold: 6,
    entropyRecoveryPerLevel: 2,
    entropyMissBase: 1,
    entropyPerDeviationUnit: 0.2,
    maxEntropyGainPerLevel: 1,
    balancedLevelBonus: 750,
    // Each further consecutive balanced checkpoint adds a step on top, up to the
    // cap on what one checkpoint pays in total.
    streakStep: 750,
    streakCap: 3_500,
    purgeScorePenalty: 250,
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
