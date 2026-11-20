import { pgTable, varchar, timestamp } from 'drizzle-orm/pg-core';

/** Opaque session IDs never persist; hash lookup supports durable revocation. */
export const operatorSessions = pgTable('operator_sessions', {
  sessionHash: varchar('session_hash', { length: 64 }).primaryKey(),
  operatorId: varchar('operator_id', { length: 64 }).notNull(),
  tokenFingerprint: varchar('token_fingerprint', { length: 64 }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});
