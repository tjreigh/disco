import type { GameModeConfig } from './mode.js';
import { CLASSIC_MODE } from './classic.js';
import { GRAVITY_MODE } from './gravity.js';
import { STACK_MODE } from './stack.js';

export { CLASSIC_MODE } from './classic.js';
export { GRAVITY_MODE } from './gravity.js';
export { STACK_MODE } from './stack.js';
export type { GameModeConfig } from './mode.js';

// NOTE: every mode id listed here must also be accepted by the API's
// modeIdSchema (api/src/stats/schemas.ts) and api/test/mode-ids.test.ts,
// or signed-in players in that mode cannot sync stats (audit-2 finding #1).
export const GAME_MODES: readonly GameModeConfig[] = [CLASSIC_MODE, GRAVITY_MODE, STACK_MODE];
