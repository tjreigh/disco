import type { RevealStep } from '../events.js';
import type { Board, Disc, GridPos } from '../model.js';

export interface BoardRules {
  readonly kind: 'rectangular-grid@1';
  readonly cols: number;
  readonly rows: number;
}

export type PlacementRules =
  | {
    readonly kind: 'downward-drop@1';
  }
  | {
    readonly kind: 'stage-and-tilt@1';
    readonly initialAngleDeg: number;
    readonly maxTiltDeltaDeg: number;
  };

export type ClearingRules =
  | {
    readonly kind: 'orthogonal-count-match@1';
    readonly isClearable: (
      board: Board,
      row: number,
      col: number,
      disc: Disc,
      angleDeg?: number,
    ) => boolean;
  }
  | {
    readonly kind: 'gravity-aligned-count-match@1';
    readonly isClearable: (
      board: Board,
      row: number,
      col: number,
      disc: Disc,
      angleDeg?: number,
    ) => boolean;
  };

export interface RevealRules {
  readonly kind: 'adjacent-crack-reveal@1';
  readonly revealAdjacent: (board: Board, cleared: GridPos[]) => RevealStep;
}

export interface GenerationRules {
  readonly kind: 'adaptive-history@1';
  readonly discValueMin: number;
  readonly discValueMax: number;
  readonly initialUnnumberedProbability: number;
  readonly unnumberedProbabilityLevelStep: number;
  readonly maxUnnumberedProbability: number;
  readonly minLevelForBoardClearBonus: number;
  /** Whether choices may vary with the live board even when the seed is shared. */
  readonly boardAdaptive: boolean;
  /** Hard cap on repeats of the same disc value in a row. */
  readonly maxSameValueRun: number;
  /** Hard cap on consecutive Numbered discs. */
  readonly maxNumberedRun: number;
  /** Hard cap on consecutive DoubleCracked discs. */
  readonly maxCrackedRun: number;
  readonly valueBalanceWindow: number;
  readonly valueBalanceStrength: number;
  readonly kindBalanceWindow: number;
  readonly kindBalanceStrength: number;
  readonly boardPressureStartHeight: number;
  readonly boardPressureStrength: number;
  readonly boardRelevanceStrength: number;
}

export type ScoringRules =
  | {
    readonly kind: 'chain-score@1';
    readonly pointsPerDisc: number;
    readonly chainExponent: number;
    readonly levelBonus: number;
    readonly boardClearBonus: number;
  }
  | {
    readonly kind: 'stack-score@1';
    readonly pointsPerStackUnit: number;
    readonly levelBonus: number;
    readonly boardClearBonus: number;
  };

export interface ProgressionRules {
  readonly kind: 'level-pressure@1';
  readonly initialTurnsPerLevel: number;
  readonly turnsPerLevelStep: number;
  readonly minTurnsPerLevel: number;
}

export interface FailureRules {
  readonly kind: 'overflow-or-full-board-ends-run@1';
  readonly isTerminalBoard: (board: Board) => boolean;
  readonly gameOverReason: (
    pushOverflow: boolean,
    board: Board,
  ) => 'push-overflow' | 'board-full' | undefined;
}

/** Enables deterministic rewind through a bounded history of stable turns. */
export interface RewindRuleModifier {
  readonly kind: 'rewind-instability@1';
  readonly historyDepth: number;
  readonly criticalInstability: number;
  readonly pressureStepInstability: number;
  readonly maxTurnCost: number;
  readonly temporalEcho: {
    readonly tiers: readonly {
      readonly minimumInstability: number;
      readonly probability: number;
    }[];
  };
}

/**
 * Closed union for orthogonal rule capabilities. Rewind is the only current
 * member; future modifiers extend this union without changing GameRulesConfig.
 */
export type RuleModifier = RewindRuleModifier;

export interface GameRulesConfig {
  readonly id: string;
  readonly version: number;
  readonly board: BoardRules;
  readonly placement: PlacementRules;
  readonly clearing: ClearingRules;
  readonly revealing: RevealRules;
  readonly generation: GenerationRules;
  readonly scoring: ScoringRules;
  readonly progression: ProgressionRules;
  readonly failure: FailureRules;
  readonly modifiers: readonly RuleModifier[];
}

export interface SoloSessionRules {
  readonly kind: 'solo-run@1';
}

export interface SoloPersistenceRules {
  readonly kind: 'solo-autosave@1';
  readonly enabled: boolean;
}

export interface SoloStatsRules {
  readonly kind: 'solo-account-stats@1';
  readonly enabled: boolean;
  readonly leaderboardEligible: boolean;
}

export interface SoloModeDefinition {
  readonly kind: 'solo';
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly hasTutorial: boolean;
  readonly rules: GameRulesConfig;
  readonly session: SoloSessionRules;
  readonly persistence: SoloPersistenceRules;
  readonly stats: SoloStatsRules;
}

export type MultiplayerFairnessRules =
  | { readonly kind: 'identical-sequence' }
  | { readonly kind: 'same-seed-adaptive' }
  | { readonly kind: 'independent' };

export interface MultiplayerSessionRules {
  readonly kind: 'timed-score-race@1';
  readonly durationMs: number;
  readonly fairness: MultiplayerFairnessRules;
}

export interface MultiplayerModeDefinition {
  readonly kind: 'multiplayer';
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  readonly rules: GameRulesConfig;
  readonly session: MultiplayerSessionRules;
}

export interface RuleCapabilities {
  readonly canTilt: boolean;
  readonly canRewind: boolean;
}

export const SOLO_RUN_SESSION: SoloSessionRules = Object.freeze({ kind: 'solo-run@1' });
export const SOLO_AUTOSAVE: SoloPersistenceRules = Object.freeze({
  kind: 'solo-autosave@1',
  enabled: true,
});
export const SOLO_ACCOUNT_STATS: SoloStatsRules = Object.freeze({
  kind: 'solo-account-stats@1',
  enabled: true,
  leaderboardEligible: true,
});

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function assertProbability(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function defineGameRules(config: GameRulesConfig): GameRulesConfig {
  if (!config.id.trim()) throw new Error('Game rules id must not be empty');
  assertPositiveInteger(config.version, `Rules version for ${config.id}`);
  assertPositiveInteger(config.board.cols, `Board columns for ${config.id}`);
  assertPositiveInteger(config.board.rows, `Board rows for ${config.id}`);

  const usesGravityPlacement = config.placement.kind === 'stage-and-tilt@1';
  const usesGravityClearing = config.clearing.kind === 'gravity-aligned-count-match@1';
  if (usesGravityPlacement !== usesGravityClearing) {
    throw new Error(
      `Rules ${config.id}@${config.version} must pair stage-and-tilt placement with gravity-aligned clearing`,
    );
  }
  if (usesGravityPlacement) {
    if (!Number.isFinite(config.placement.initialAngleDeg)) {
      throw new Error(`Initial gravity angle for ${config.id} must be finite`);
    }
    if (!Number.isFinite(config.placement.maxTiltDeltaDeg)
      || config.placement.maxTiltDeltaDeg <= 0) {
      throw new Error(`Maximum gravity tilt for ${config.id} must be positive`);
    }
  }

  const generation = config.generation;
  assertPositiveInteger(generation.discValueMin, `Minimum disc value for ${config.id}`);
  assertPositiveInteger(generation.discValueMax, `Maximum disc value for ${config.id}`);
  if (generation.discValueMin > generation.discValueMax) {
    throw new Error(`Disc value range for ${config.id} is inverted`);
  }
  assertProbability(
    generation.initialUnnumberedProbability,
    `Initial unnumbered probability for ${config.id}`,
  );
  assertProbability(
    generation.maxUnnumberedProbability,
    `Maximum unnumbered probability for ${config.id}`,
  );
  if (generation.unnumberedProbabilityLevelStep < 0
    || generation.initialUnnumberedProbability > generation.maxUnnumberedProbability) {
    throw new Error(`Unnumbered probability progression for ${config.id} is invalid`);
  }
  for (const [label, value] of [
    ['maxSameValueRun', generation.maxSameValueRun],
    ['maxNumberedRun', generation.maxNumberedRun],
    ['maxCrackedRun', generation.maxCrackedRun],
    ['valueBalanceWindow', generation.valueBalanceWindow],
    ['kindBalanceWindow', generation.kindBalanceWindow],
    ['minLevelForBoardClearBonus', generation.minLevelForBoardClearBonus],
  ] as const) {
    assertPositiveInteger(value, `${label} for ${config.id}`);
  }

  const progression = config.progression;
  assertPositiveInteger(
    progression.initialTurnsPerLevel,
    `Initial turn budget for ${config.id}`,
  );
  if (!Number.isSafeInteger(progression.turnsPerLevelStep)
    || progression.turnsPerLevelStep < 0) {
    throw new Error(`Turn-budget step for ${config.id} must be a non-negative integer`);
  }
  assertPositiveInteger(progression.minTurnsPerLevel, `Minimum turn budget for ${config.id}`);
  if (progression.minTurnsPerLevel > progression.initialTurnsPerLevel) {
    throw new Error(`Minimum turn budget for ${config.id} exceeds its initial budget`);
  }

  const modifierKinds = new Set<string>();
  for (const modifier of config.modifiers) {
    if (modifierKinds.has(modifier.kind)) {
      throw new Error(`Rules ${config.id}@${config.version} repeat modifier ${modifier.kind}`);
    }
    modifierKinds.add(modifier.kind);
    assertPositiveInteger(modifier.historyDepth, `Rewind history depth for ${config.id}`);
    assertPositiveInteger(modifier.pressureStepInstability, `Rewind pressure step for ${config.id}`);
    assertPositiveInteger(modifier.maxTurnCost, `Maximum rewind turn cost for ${config.id}`);
    for (const tier of modifier.temporalEcho.tiers) {
      assertPositiveInteger(tier.minimumInstability, `Temporal Echo tier for ${config.id}`);
      assertProbability(tier.probability, `Temporal Echo probability for ${config.id}`);
    }
  }
  if (usesGravityPlacement && modifierKinds.has('rewind-instability@1')) {
    throw new Error(`Rules ${config.id}@${config.version} cannot combine Gravity and rewind`);
  }

  return deepFreeze(config);
}

export function defineSoloMode(definition: SoloModeDefinition): SoloModeDefinition {
  if (definition.id !== definition.rules.id) {
    throw new Error(
      `Solo mode ${definition.id} must use a ruleset with the same stable id; received ${definition.rules.id}`,
    );
  }
  return deepFreeze(definition);
}

export function defineMultiplayerMode(
  definition: MultiplayerModeDefinition,
): MultiplayerModeDefinition {
  if (definition.id !== definition.rules.id) {
    throw new Error(
      `Multiplayer mode ${definition.id} must use a ruleset with the same stable id; received ${definition.rules.id}`,
    );
  }
  if (definition.session.fairness.kind === 'identical-sequence'
    && definition.rules.generation.boardAdaptive) {
    throw new Error(
      `Multiplayer mode ${definition.id} promises identical sequences with a board-adaptive generator`,
    );
  }
  return deepFreeze(definition);
}

export function rewindModifier(
  rules: Pick<GameRulesConfig, 'modifiers'>,
): RewindRuleModifier | undefined {
  return rules.modifiers.find(
    (modifier): modifier is RewindRuleModifier => modifier.kind === 'rewind-instability@1',
  );
}

export function capabilitiesForRules(rules: GameRulesConfig): RuleCapabilities {
  return {
    canTilt: rules.placement.kind === 'stage-and-tilt@1',
    canRewind: rewindModifier(rules) !== undefined,
  };
}

export function turnsForLevel(rules: ProgressionRules, level: number): number {
  return Math.max(
    rules.minTurnsPerLevel,
    rules.initialTurnsPerLevel - rules.turnsPerLevelStep * (level - 1),
  );
}

export function turnCostForInstability(
  rules: Pick<GameRulesConfig, 'modifiers'>,
  instability: number,
): number {
  const rewind = rewindModifier(rules);
  if (!rewind) return 1;
  const normalized = Math.max(0, Math.floor(instability));
  const step = Math.max(1, rewind.pressureStepInstability);
  return Math.min(rewind.maxTurnCost, 1 + Math.floor(normalized / step));
}

export function temporalEchoProbability(
  rules: Pick<GameRulesConfig, 'modifiers'>,
  instability: number,
): number {
  const rewind = rewindModifier(rules);
  if (!rewind) return 0;
  const normalized = Math.max(0, Math.floor(instability));
  let probability = 0;
  for (const tier of rewind.temporalEcho.tiers) {
    if (normalized < tier.minimumInstability) continue;
    probability = Math.max(probability, tier.probability);
  }
  return Math.max(0, Math.min(1, probability));
}

export function unnumberedProbabilityForLevel(
  rules: GenerationRules,
  level: number,
): number {
  const levelOffset = Math.max(1, level) - 1;
  return Math.min(
    rules.maxUnnumberedProbability,
    rules.initialUnnumberedProbability + rules.unnumberedProbabilityLevelStep * levelOffset,
  );
}
