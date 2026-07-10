import type { GameModeConfig } from './mode.js';
import { CLASSIC_MODE } from './classic.js';
import { GRAVITY_MODE } from './gravity.js';

export { CLASSIC_MODE } from './classic.js';
export { GRAVITY_MODE } from './gravity.js';
export type { GameModeConfig } from './mode.js';

export const GAME_MODES: readonly GameModeConfig[] = [CLASSIC_MODE, GRAVITY_MODE];
