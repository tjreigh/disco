import type { GameModeConfig } from './mode.js';
import { CLASSIC_MODE } from './classic.js';

/** Classic play with a deterministic, costly one-turn timeline rewind. */
export const PARADOX_MODE: GameModeConfig = {
  ...CLASSIC_MODE,
  id: 'paradox',
  name: 'Paradox',
  tagline: 'Rewind your mistakes, but every erased turn fractures the board.',
  rewind: { historyDepth: 1, criticalInstability: 5 },
  hasTutorial: false,
};
