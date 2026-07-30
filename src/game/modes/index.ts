import type {
  GameRulesConfig,
  MultiplayerModeDefinition,
  SoloModeDefinition,
} from './mode.js';
import { CLASSIC_MODE, CLASSIC_RULES } from './classic.js';
import { GRAVITY_MODE, GRAVITY_RULES } from './gravity.js';
import { PARADOX_MODE, PARADOX_RULES } from './paradox.js';
import { SCORE_RACE_MODE, SCORE_RACE_RULES } from './score-race.js';
import { STACK_MODE, STACK_RULES } from './stack.js';

export { CLASSIC_MODE, CLASSIC_RULES } from './classic.js';
export { GRAVITY_MODE, GRAVITY_RULES } from './gravity.js';
export { PARADOX_MODE, PARADOX_RULES } from './paradox.js';
export { SCORE_RACE_MODE, SCORE_RACE_RULES } from './score-race.js';
export { STACK_MODE, STACK_RULES } from './stack.js';
export type {
  BoardRules,
  ClearingRules,
  FailureRules,
  GameRulesConfig,
  GenerationRules,
  MultiplayerModeDefinition,
  PlacementRules,
  ProgressionRules,
  RevealRules,
  RewindRuleModifier,
  RuleCapabilities,
  RuleModifier,
  ScoringRules,
  SoloModeDefinition,
} from './mode.js';

export const SOLO_MODES: readonly SoloModeDefinition[] = [
  CLASSIC_MODE,
  GRAVITY_MODE,
  STACK_MODE,
  PARADOX_MODE,
];

export const MULTIPLAYER_MODES: readonly MultiplayerModeDefinition[] = [
  SCORE_RACE_MODE,
];

export const GAME_RULESETS: readonly GameRulesConfig[] = [
  CLASSIC_RULES,
  GRAVITY_RULES,
  STACK_RULES,
  PARADOX_RULES,
  SCORE_RACE_RULES,
];

export function validateModeRegistries(
  soloModes: readonly SoloModeDefinition[],
  multiplayerModes: readonly MultiplayerModeDefinition[],
  rulesets: readonly GameRulesConfig[],
): void {
  const modeIds = new Set<string>();
  for (const mode of [...soloModes, ...multiplayerModes]) {
    if (modeIds.has(mode.id)) throw new Error(`Duplicate mode id: ${mode.id}`);
    modeIds.add(mode.id);
  }

  const rulesIdentities = new Set<string>();
  for (const rules of rulesets) {
    const identity = `${rules.id}@${rules.version}`;
    if (rulesIdentities.has(identity)) throw new Error(`Duplicate rules identity: ${identity}`);
    rulesIdentities.add(identity);
  }

  for (const mode of [...soloModes, ...multiplayerModes]) {
    const identity = `${mode.rules.id}@${mode.rules.version}`;
    if (!rulesIdentities.has(identity)) {
      throw new Error(`Mode ${mode.id} references unregistered rules ${identity}`);
    }
  }
}

validateModeRegistries(SOLO_MODES, MULTIPLAYER_MODES, GAME_RULESETS);

export function getSoloMode(modeId: string): SoloModeDefinition {
  const mode = SOLO_MODES.find(candidate => candidate.id === modeId);
  if (!mode) throw new Error(`Unsupported solo mode: ${modeId}`);
  return mode;
}

export function getMultiplayerMode(modeId: string): MultiplayerModeDefinition {
  const mode = MULTIPLAYER_MODES.find(candidate => candidate.id === modeId);
  if (!mode) throw new Error(`Unsupported multiplayer mode: ${modeId}`);
  return mode;
}

export function getGameRules(rulesId: string, version: number): GameRulesConfig {
  const rules = GAME_RULESETS.find(
    candidate => candidate.id === rulesId && candidate.version === version,
  );
  if (!rules) throw new Error(`Unsupported game rules: ${rulesId}@${version}`);
  return rules;
}
