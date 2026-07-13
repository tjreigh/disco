import { z } from 'zod';
import { modeIdSchema } from '../stats/schemas.js';

export const SAVE_BODY_LIMIT = 64 * 1024;

const basicSaveSchema = z.object({
  version: z.literal(1),
  rulesVersion: z.literal(1),
  savedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  modeId: modeIdSchema,
  state: z.record(z.unknown()),
  generation: z.record(z.unknown()),
  session: z.record(z.unknown()),
  meta: z.record(z.unknown()),
}).passthrough();

const expectedRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const saveSlotWriteSchema = z.union([
  z.object({
    expectedRevision: expectedRevisionSchema,
    runId: z.string().uuid(),
    save: basicSaveSchema,
  }).strict(),
  z.object({
    expectedRevision: expectedRevisionSchema,
    runId: z.null(),
    save: z.null(),
  }).strict(),
]);
