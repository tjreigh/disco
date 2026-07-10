import { z } from 'zod';

export const modeIdSchema = z.enum(['classic']);

export const statsSchema = z.object({
  modeId: modeIdSchema,
  highScore: z.number().int().min(0).max(2_000_000_000),
  longestStreak: z.number().int().min(0).max(10_000),
  gamesPlayed: z.number().int().min(0).max(2_000_000_000),
  totalScore: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
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
