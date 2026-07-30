import { makeDisc } from '../game/disc.js';
import { DiscKind } from '../game/model.js';
import type { Disc } from '../game/model.js';
import { CLASSIC_RULES } from '../game/modes/index.js';
import type {
  BoardRules,
  GameRulesConfig,
  GenerationRules,
  ProgressionRules,
  ScoringRules,
} from '../game/modes/mode.js';

export interface TestRulesOverrides extends Omit<
  Partial<GameRulesConfig>,
  'board' | 'generation' | 'scoring' | 'progression'
> {
  board?: Partial<BoardRules>;
  generation?: Partial<GenerationRules>;
  scoring?: Partial<ScoringRules>;
  progression?: Partial<ProgressionRules>;
}

/**
 * Builds an isolated test ruleset from focused nested overrides. Production
 * rules remain explicitly composed and never use this partial builder.
 */
export function testMode(
  overrides: TestRulesOverrides = {},
  base: GameRulesConfig = CLASSIC_RULES,
): GameRulesConfig {
  const scoring = { ...base.scoring, ...overrides.scoring } as ScoringRules;
  const generation = {
    ...base.generation,
    ...overrides.generation,
  } as GenerationRules;
  return {
    ...base,
    ...overrides,
    board: { ...base.board, ...overrides.board },
    generation,
    scoring,
    progression: { ...base.progression, ...overrides.progression },
    modifiers: overrides.modifiers
      ? overrides.modifiers.map(modifier => ({
          ...modifier,
          temporalEcho: {
            tiers: modifier.temporalEcho.tiers.map(tier => ({ ...tier })),
          },
        }))
      : base.modifiers.map(modifier => ({
          ...modifier,
          temporalEcho: {
            tiers: modifier.temporalEcho.tiers.map(tier => ({ ...tier })),
          },
        })),
  };
}

export function numberedFactory(...values: number[]): () => Disc {
  let index = 0;
  return () => makeDisc(values[index++ % values.length]!, DiscKind.Numbered);
}

export function doubleCrackedFactory(value = 7): () => Disc {
  return () => makeDisc(value, DiscKind.DoubleCracked);
}
