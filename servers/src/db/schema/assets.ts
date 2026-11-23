import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid, varchar } from 'drizzle-orm/pg-core';
import { films } from './films.js';
import { attempts } from './financial.js';
import { shotRevisions, storyRevisionShots } from './stories.js';

export const assets = pgTable('assets', {
  id: uuid('id').primaryKey(),
  filmId: uuid('film_id').notNull().references(() => films.id),
  attemptId: uuid('attempt_id').notNull().unique().references(() => attempts.id),
  shotRevisionId: uuid('shot_revision_id').notNull(),
  kind: text('kind').notNull(),
  storagePath: text('storage_path').notNull(),
  sha256Hash: varchar('sha256_hash', { length: 64 }).notNull(),
  mimeType: varchar('mime_type', { length: 64 }).notNull(),
  byteSize: bigint('byte_size', { mode: 'bigint' }).notNull(),
  verified: boolean('verified').notNull().default(true),
  metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique().on(table.filmId, table.id),
  foreignKey({
    columns: [table.filmId, table.shotRevisionId],
    foreignColumns: [shotRevisions.filmId, shotRevisions.id],
  }),
  foreignKey({
    columns: [table.filmId, table.shotRevisionId, table.kind, table.attemptId],
    foreignColumns: [attempts.filmId, attempts.shotRevisionId, attempts.kind, attempts.id],
  }),
  check('asset_kind_valid', sql`${table.kind} IN ('IMAGE', 'VIDEO')`),
  check('asset_byte_size_nonnegative', sql`${table.byteSize} >= 0`),
]);

export const assetReviews = pgTable('asset_reviews', {
  id: uuid('id').primaryKey(),
  assetId: uuid('asset_id').notNull(),
  filmId: uuid('film_id').notNull().references(() => films.id),
  shotRevisionId: uuid('shot_revision_id').notNull(),
  actorId: varchar('actor_id', { length: 64 }).notNull(),
  decision: text('decision').notNull(),
  reason: text('reason').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('asset_reviews_latest_idx').on(table.assetId, table.createdAt, table.id),
  foreignKey({
    columns: [table.filmId, table.assetId],
    foreignColumns: [assets.filmId, assets.id],
  }),
  foreignKey({
    columns: [table.filmId, table.shotRevisionId],
    foreignColumns: [shotRevisions.filmId, shotRevisions.id],
  }),
  check('asset_review_decision_valid', sql`${table.decision} IN ('APPROVED', 'REJECTED')`),
]);

export const shotAssetSelections = pgTable('shot_asset_selections', {
  storyRevisionId: uuid('story_revision_id').notNull(),
  shotId: uuid('shot_id').notNull(),
  kind: text('kind').notNull(),
  shotRevisionId: uuid('shot_revision_id').notNull(),
  assetId: uuid('asset_id').notNull(),
  filmId: uuid('film_id').notNull().references(() => films.id),
  selectedBy: varchar('selected_by', { length: 64 }).notNull(),
  selectedAt: timestamp('selected_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique().on(table.storyRevisionId, table.shotId, table.kind),
  foreignKey({
    columns: [table.storyRevisionId, table.shotId],
    foreignColumns: [storyRevisionShots.storyRevisionId, storyRevisionShots.shotId],
  }),
  foreignKey({
    columns: [table.filmId, table.assetId],
    foreignColumns: [assets.filmId, assets.id],
  }),
  foreignKey({
    columns: [table.filmId, table.shotRevisionId],
    foreignColumns: [shotRevisions.filmId, shotRevisions.id],
  }),
  check('shot_asset_selection_kind_valid', sql`${table.kind} IN ('IMAGE', 'VIDEO')`),
]);
