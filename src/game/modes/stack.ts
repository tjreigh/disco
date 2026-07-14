import type { GameModeConfig } from './mode.js';
import { CLASSIC_MODE } from './classic.js';

// Stack mode deliberately keeps Classic's board, disc generation, clearing,
// cracked-disc, gravity, and level-pressure rules. Only scoring changes: each
// player drop earns one award for all numbered discs cleared by its cascade.
export const STACK_MODE: GameModeConfig = {
  ...CLASSIC_MODE,
  id: 'stack',
  name: 'Stack',
  tagline: 'One drop, one cascade—the more discs it clears, the bigger the payoff.',
  // The player always receives a numbered disc. Cracked discs remain part of
  // Stack's level-push pressure, not the normal drop queue.
  initialUnnumberedProbability: 0,
  unnumberedProbabilityLevelStep: 0,
  maxUnnumberedProbability: 0,
  scoring: { kind: 'stack', pointsPerStackUnit: 10 },
  initialTurnsPerLevel: 22,
};
