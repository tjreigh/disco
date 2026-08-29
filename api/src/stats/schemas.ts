import { z } from 'zod';

// Must cover exactly the ids of solo modes with stats/persistence enabled in
// src/game/modes/index.ts's SOLO_MODES registry (currently every solo mode).
// Score Race and Disco Duel are multiplayer-only and must not be added here;
// solo stats/save sync is a different capability from multiplayer play. If a
// multiplayer mode ever needs its own stats/save capability, give it a
// dedicated schema rather than widening this one. Adding a stats-eligible
// solo mode without adding it here reproduces audit-2 finding #1:
// signed-in players in the new mode get 400s on every stats sync.
// api/test/mode-ids.test.ts asserts this list against the live registry.
export const modeIdSchema = z.enum(['classic', 'gravity', 'stack', 'paradox', 'ration']);

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
