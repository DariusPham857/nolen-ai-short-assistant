import { z } from 'zod';

export const MAX_MICROS = '9223372036854775807';
export const microsSchema = z.string().regex(/^(0|[1-9]\d*)$/).refine(
  value => /^(0|[1-9]\d*)$/.test(value) && value.length <= MAX_MICROS.length && BigInt(value) <= BigInt(MAX_MICROS), 'Budget exceeds BIGINT maximum',
);
export const createFilmSchema = z.object({
  title: z.string().trim().min(1).max(255),
  brief: z.string().trim().min(1).max(10000),
  budgetLimitUsdMicros: microsSchema,
  durationTargetSeconds: z.number().int().min(30).max(60),
  aspectRatio: z.literal('9:16'),
  styleNotes: z.string().trim().max(2000).nullable().optional().transform(value => value || null),
}).strict();
export type CreateFilm = z.infer<typeof createFilmSchema>;

/** Fixed field order is the canonical hash input, independent of raw JSON order. */
export function normalizeFilm(input: unknown): CreateFilm {
  const value = createFilmSchema.parse(input);
  return { title: value.title, brief: value.brief, budgetLimitUsdMicros: value.budgetLimitUsdMicros,
    durationTargetSeconds: value.durationTargetSeconds, aspectRatio: value.aspectRatio, styleNotes: value.styleNotes };
}

export const filmDtoSchema = createFilmSchema.extend({
  id: z.string().uuid(), status: z.literal('DRAFT'), activeStoryRevisionId: z.null(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export type FilmDto = z.infer<typeof filmDtoSchema>;
export const apiErrorSchema = z.object({ error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional(), requestId: z.string() }) });

/** Parse display USD using integer arithmetic only; transport is micros string. */
export function usdToMicros(input: string): string {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/.exec(input.trim());
  if (!match) throw new Error('Enter a nonnegative USD amount with up to six decimal places');
  if (match[1].length > 13) throw new Error('Budget exceeds BIGINT maximum');
  return microsSchema.parse((BigInt(match[1]) * 1000000n + BigInt((match[2] ?? '').padEnd(6, '0'))).toString());
}

/** Format all six decimal places without rounding or floating conversion. */
export function formatMicros(input: string): string {
  const value = BigInt(microsSchema.parse(input));
  return `${value / 1000000n}.${(value % 1000000n).toString().padStart(6, '0')}`;
}
