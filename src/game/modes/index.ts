import type { GameModeConfig } from './mode.js';
import { CLASSIC_MODE } from './classic.js';

export { CLASSIC_MODE } from './classic.js';
export type { GameModeConfig } from './mode.js';

export const GAME_MODES: readonly GameModeConfig[] = [CLASSIC_MODE];
