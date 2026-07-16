import type { GameModeConfig } from './mode.js';
import { CLASSIC_MODE } from './classic.js';

/** Classic play with a deterministic, increasingly costly timeline rewind. */
export const PARADOX_MODE: GameModeConfig = {
  ...CLASSIC_MODE,
  id: 'paradox',
  name: 'Paradox',
  tagline: 'Rewind your mistakes, but every erased turn fractures the board.',
  rewind: {
    historyDepth: 5,
    criticalInstability: 5,
    pressureStepInstability: 3,
    maxTurnCost: 3,
  },
  hasTutorial: false,
};
