import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { operatorSessions } from '../db/schema/sessions.js';
import { OPERATOR_ID, runtimeConfig } from '../config/runtime.js';

export const COOKIE = 'nolen_session';
export const SESSION_SECONDS = 8 * 60 * 60;
/** Digest secrets to fixed length before constant-time comparison. */
export function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }

/** Persist only opaque-ID hash; token rotation fingerprint checked on every lookup. */
export async function unlock(token: string): Promise<string | null> {
  const config = runtimeConfig();
  if (!timingSafeEqual(Buffer.from(digest(token), 'hex'), Buffer.from(config.fingerprint, 'hex'))) return null;
  const id = randomBytes(32).toString('base64url');
  await db.insert(operatorSessions).values({ sessionHash: digest(id), operatorId: OPERATOR_ID,
    tokenFingerprint: config.fingerprint, expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000) });
  return id;
}

/** Invalid credentials return null; database errors propagate as infrastructure failure. */
export async function authenticate(id: string | undefined): Promise<string | null> {
  if (!id || !/^[\w-]{43}$/.test(id)) return null;
  const [session] = await db.select().from(operatorSessions).where(and(
    eq(operatorSessions.sessionHash, digest(id)), eq(operatorSessions.tokenFingerprint, runtimeConfig().fingerprint),
    gt(operatorSessions.expiresAt, new Date()),
  ));
  return session?.operatorId ?? null;
}

/** Durable logout: callers must await deletion before reporting success. */
export async function revoke(id: string | undefined): Promise<void> {
  if (id && /^[\w-]{43}$/.test(id)) await db.delete(operatorSessions).where(eq(operatorSessions.sessionHash, digest(id)));
}
