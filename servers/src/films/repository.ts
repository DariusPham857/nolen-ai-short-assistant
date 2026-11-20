import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { normalizeFilm, filmDtoSchema, type CreateFilm, type FilmDto } from '@nolen/contracts';
import { db } from '../db/index.js';
import { films, type Film } from '../db/schema/films.js';

/** Convert persisted bigint into the explicit browser-safe DTO; internal fields stay private. */
export function filmDto(row: Film): FilmDto {
  if (row.aspectRatio !== '9:16') {
    throw new Error('Film outside FC-001 contract');
  }
  return { id: row.id, title: row.title, brief: row.brief, budgetLimitUsdMicros: row.budgetLimitUsdMicros.toString(),
    durationTargetSeconds: row.durationTargetSeconds, aspectRatio: row.aspectRatio, styleNotes: row.styleNotes,
    status: row.status, activeStoryRevisionId: row.activeStoryRevisionId,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/** Hash fixed-order validated/normalized content, never raw request JSON. */
export function requestHash(input: CreateFilm): string {
  return createHash('sha256').update(JSON.stringify(normalizeFilm(input))).digest('hex');
}

export class IdempotencyConflict extends Error {}

/** Commit-before-response; conflict SELECT is a NEW READ COMMITTED statement. */
export async function createFilm(input: CreateFilm, key: string, operatorId: string): Promise<FilmDto> {
  const hash = requestHash(input);
  return db.transaction(async tx => {
    const [inserted] = await tx.insert(films).values({ ...input,
      budgetLimitUsdMicros: BigInt(input.budgetLimitUsdMicros), operatorId, idempotencyKey: key, requestHash: hash,
    }).onConflictDoNothing({ target: [films.operatorId, films.idempotencyKey] }).returning();
    if (inserted) {
      const receipt=filmDto(inserted);
      await tx.update(films).set({createReceipt:receipt}).where(eq(films.id,inserted.id));
      return receipt;
    }
    const [existing] = await tx.select().from(films).where(and(eq(films.operatorId, operatorId), eq(films.idempotencyKey, key)));
    if (!existing) throw new Error('Idempotency row unavailable');
    if (existing.requestHash !== hash) throw new IdempotencyConflict();
    return filmDtoSchema.parse(existing.createReceipt);
  }, { isolationLevel: 'read committed' });
}

/** Read only the current operator's Film. */
export async function getFilm(id: string, operatorId: string): Promise<FilmDto | null> {
  const [row] = await db.select().from(films).where(and(eq(films.id, id), eq(films.operatorId, operatorId)));
  return row ? filmDto(row) : null;
}
