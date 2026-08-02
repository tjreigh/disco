import { z } from 'zod';

// Must cover every id in the front end's GAME_MODES (src/game/modes/index.ts).
// Adding a mode there without adding it here reproduces audit-2 finding #1:
// signed-in players in the new mode get 400s on every stats sync.
export const modeIdSchema = z.enum(['classic', 'gravity', 'stack', 'paradox']);

export const statsSchema = z.object({
  modeId: modeIdSchema,
  highScore: z.number().int().min(0).max(2_000_000_000),
  longestStreak: z.number().int().min(0).max(10_000),
  gamesPlayed: z.number().int().min(0).max(2_000_000_000),
  totalScore: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  // Defaults keep older deployed clients compatible with the expanded schema.
  totalPlayTimeMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  totalDiscsDropped: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  totalDiscsBroken: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  averageScore: z.number().int().min(0).max(2_000_000_000),
});

export const scoreSubmissionSchema = z.object({
  score: z.number().int().min(0).max(2_000_000_000),
  longestStreak: z.number().int().min(0).max(10_000).default(0),
  clientStats: statsSchema.nullable().optional(),
});

export function normalizeStats(input: z.infer<typeof statsSchema>): z.infer<typeof statsSchema> {
  return {
    ...input,
    averageScore: input.gamesPlayed > 0 ? Math.round(input.totalScore / input.gamesPlayed) : 0,
  };
}
