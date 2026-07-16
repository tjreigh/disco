import type { Board, Disc, GridPos } from '../model.js';
import type { RevealStep } from '../events.js';

/** Determines how clears made during a turn translate into score. */
export type ScoringConfig =
  | { readonly kind: 'chain' }
  | {
    readonly kind: 'stack';
    /** Points = unit × stackSize². */
    readonly pointsPerStackUnit: number;
  };

/** Enables deterministic rewind through a bounded history of stable turns. */
export interface RewindModeConfig {
  readonly historyDepth: number;
  /** Instability value at which presentation should communicate critical damage. */
  readonly criticalInstability: number;
  /** Every complete step adds one turn pip to the cost of each move. */
  readonly pressureStepInstability: number;
  /** Upper bound on turn pips consumed by one move. */
  readonly maxTurnCost: number;
  /** Instability tiers that can repeat a completed drop into another legal lane. */
  readonly temporalEcho: {
    readonly tiers: readonly {
      readonly minimumInstability: number;
      readonly probability: number;
    }[];
  };
}

export interface GameModeConfig {
  readonly id: string;
  readonly name: string;
  readonly tagline: string;
  /** Whether this mode has a guided tutorial available from the home screen. Defaults to true. */
  readonly hasTutorial?: boolean;
  readonly board: { cols: number; rows: number };
  /** Inclusive range of numbered disc values that can be dealt. Widening it makes matches rarer (more values to spread across). */
  readonly discValueMin: number;
  readonly discValueMax: number;
  /** Chance a dealt disc is DoubleCracked (unnumbered/hazard) at level 1. See {@link unnumberedProbabilityForLevel}. */
  readonly initialUnnumberedProbability: number;
  /** Flat amount added to the unnumbered probability per level (linear ramp, not exponential). Higher = hazards ramp up faster. */
  readonly unnumberedProbabilityLevelStep: number;
  /** Ceiling the unnumbered probability ramp saturates at, however high the level gets. */
  readonly maxUnnumberedProbability: number;
  readonly discGeneration: DiscGenerationConfig;
  readonly scoring: ScoringConfig;
  /** Present only for modes that can restore a completed turn. */
  readonly rewind?: RewindModeConfig;
  /** Base points per disc in a clear, before the chain-length exponent is applied. See {@link pointsForChain}. */
  readonly pointsPerDisc: number;
  /** Exponent on chain length in the scoring formula (points = pointsPerDisc * chainLength^chainExponent). >1 makes longer chains reward superlinearly; higher values make big chains far more lucrative than several small ones. */
  readonly chainExponent: number;
  /** Flat bonus awarded once when a level is completed. */
  readonly levelBonus: number;
  /** Flat bonus awarded once when the board is fully cleared. */
  readonly boardClearBonus: number;
  /** Below this level, a disc value can't be dealt in a way that would let it immediately complete a board-emptying clear. */
  readonly minLevelForBoardClearBonus: number;
  /** Turn budget for level 1. See {@link turnsForLevel}. */
  readonly initialTurnsPerLevel: number;
  /** Amount the turn budget shrinks per level (linear decay) as levels progress. */
  readonly turnsPerLevelStep: number;
  /** Floor the shrinking turn budget cannot drop below, however high the level gets. */
  readonly minTurnsPerLevel: number;
  /**
   * Present only for Gravity mode. Each turn stages a lane, requires a tilt,
   * then settles the staged disc and board under the committed angle. See
   * {@link GameEngine.drop}/{@link GameEngine.tiltGravity}/{@link GameEngine.commitTilt}/{@link GameEngine.cancelTilt}.
   */
  readonly gravity?: {
    readonly initialAngleDeg: number;
    /** Maximum absolute tilt allowed from a tilt action's starting angle. */
    readonly maxTiltDeltaDeg: number;
  };
  // angleDeg is the current gravity angle a Gravity-family mode's run check
  // should measure runs along (see gravityRunLengths in gravity/settling.ts, which
  // snaps it to the nearest of 8 directions — a genuinely continuous run
  // check isn't well-defined on a discrete grid) — always the same angle the
  // caller just settled the board under, so a run means the same thing here
  // as it does to the settling that produced this board. Omitted (defaults
  // to grid-up/down) for modes with no gravity concept.
  isClearable(board: Board, row: number, col: number, disc: Disc, angleDeg?: number): boolean;
  revealAdjacent(board: Board, cleared: GridPos[]): RevealStep;
  isGameOver(board: Board): boolean;
}

export interface DiscGenerationConfig {
  /** Hard cap on repeats of the same disc value in a row; that value is excluded once hit. Lower = more variety, never 0. */
  readonly maxSameValueRun: number;
  /** Hard cap on consecutive Numbered discs; the next disc is forced DoubleCracked once hit. Lower = more frequent forced hazards. */
  readonly maxNumberedRun: number;
  /** Hard cap on consecutive DoubleCracked discs; the next disc is forced Numbered once hit. Lower = fewer hazard streaks. */
  readonly maxCrackedRun: number;
  /** How many recent discs count toward "expected vs. observed" value frequency. Bigger = smoother/slower-reacting value distribution. */
  readonly valueBalanceWindow: number;
  /** How hard under/over-dealt values get pushed back toward even distribution. 0 = no correction (pure weighted random); higher = snappier correction. */
  readonly valueBalanceStrength: number;
  /** How many recent discs count toward "expected vs. observed" Numbered ratio. Bigger = smoother/slower-reacting kind distribution. */
  readonly kindBalanceWindow: number;
  /** How hard the Numbered/DoubleCracked ratio gets pushed back toward the level's target probability. 0 = no correction; higher = snappier correction. */
  readonly kindBalanceStrength: number;
  /** Column height (in rows), below which "board pressure" is 0 (no bias yet). Higher = more room before pressure kicks in. */
  readonly boardPressureStartHeight: number;
  /** As pressure rises (tall columns), how strongly high-value discs get suppressed in favor of low ones. 0 = no suppression; higher = low values dealt almost exclusively near the top. */
  readonly boardPressureStrength: number;
  /** As pressure rises, how strongly values that would immediately complete a clear get boosted. 0 = no boost; higher = generation actively bails you out under pressure. */
  readonly boardRelevanceStrength: number;
}

// Turn budget for a given level: shrinks by turnsPerLevelStep per level from
// initialTurnsPerLevel, floored at minTurnsPerLevel.
export function turnsForLevel(mode: GameModeConfig, level: number): number {
  return Math.max(mode.minTurnsPerLevel, mode.initialTurnsPerLevel - mode.turnsPerLevelStep * (level - 1));
}

/** Turn pips consumed by one accepted move at the supplied Instability. */
export function turnCostForInstability(mode: GameModeConfig, instability: number): number {
  if (!mode.rewind) return 1;
  const normalized = Math.max(0, Math.floor(instability));
  const step = Math.max(1, mode.rewind.pressureStepInstability);
  return Math.min(mode.rewind.maxTurnCost, 1 + Math.floor(normalized / step));
}

/** Chance that a completed move repeats into another legal lane. */
export function temporalEchoProbability(mode: GameModeConfig, instability: number): number {
  if (!mode.rewind) return 0;
  const normalized = Math.max(0, Math.floor(instability));
  let probability = 0;
  for (const tier of mode.rewind.temporalEcho.tiers) {
    if (normalized < tier.minimumInstability) continue;
    probability = Math.max(probability, tier.probability);
  }
  return Math.max(0, Math.min(1, probability));
}

/** Chance that a dealt disc is unnumbered at a given one-based level. */
export function unnumberedProbabilityForLevel(mode: GameModeConfig, level: number): number {
  const levelOffset = Math.max(1, level) - 1;
  return Math.min(
    mode.maxUnnumberedProbability,
    mode.initialUnnumberedProbability + mode.unnumberedProbabilityLevelStep * levelOffset,
  );
}
