import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  pgEnum,
  bigint,
  check,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Film status enum.
 * Top-level lifecycle — not to be confused with story or generation states.
 */
export const filmStatusEnum = pgEnum("film_status", [
  "DRAFT",
  "PLANNING",
  "IN_PRODUCTION",
  "COMPLETED",
  "ARCHIVED",
]);

/**
 * Film aspect ratio enum (DEC-P05: target 9:16 for short-form).
 */
export const aspectRatioEnum = pgEnum("aspect_ratio", [
  "9:16",
  "16:9",
  "1:1",
  "4:5",
]);

/**
 * Films table — top-level domain entity.
 *
 * Holds the production brief, budget limit (integer USD micros),
 * target duration, and active story revision pointer.
 *
 * Budget values use integer micros: 1 USD = 1,000,000 micros.
 * Floating-point currency arithmetic is prohibited (DEC-P02).
 *
 * @see PRD §5 FR-01, §16 DEC-P01
 */
export const films = pgTable("films", {
  id: uuid("id").defaultRandom().primaryKey(),

  /** Human-readable film title. */
  title: varchar("title", { length: 255 }).notNull(),

  /** Production brief / concept description. */
  brief: text("brief").notNull(),

  /** Film lifecycle status. */
  status: filmStatusEnum("status").default("DRAFT").notNull(),

  /** Maximum budget in integer USD micros (1 USD = 1,000,000). */
  budgetLimitUsdMicros: bigint("budget_limit_usd_micros", { mode: "bigint" })
    .default(sql`0`)
    .notNull(),

  /** Target duration in seconds (30–60s per PRD). */
  durationTargetSeconds: integer("duration_target_seconds")
    .default(30)
    .notNull(),

  /** Aspect ratio for all shots in this film. */
  aspectRatio: aspectRatioEnum("aspect_ratio").default("9:16").notNull(),

  /** Target audience / style description. */
  styleNotes: text("style_notes"),

  /** Active story revision pointer (FK added when story_revisions table exists). */
  activeStoryRevisionId: uuid("active_story_revision_id"),

  operatorId: varchar("operator_id", { length: 64 }).notNull(),
  idempotencyKey: uuid("idempotency_key").notNull(),
  requestHash: varchar("request_hash", { length: 64 }).notNull(),
  createReceipt: jsonb('create_receipt'),

  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),

  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
}, table => [
  uniqueIndex("films_operator_idempotency").on(table.operatorId, table.idempotencyKey),
  check("films_budget_nonnegative", sql`${table.budgetLimitUsdMicros} >= 0`),
  check("films_duration_bounds", sql`${table.durationTargetSeconds} BETWEEN 30 AND 60`),
  check("films_title_required", sql`length(trim(${table.title})) > 0`),
  check("films_brief_bounds", sql`length(trim(${table.brief})) BETWEEN 1 AND 10000`),
  check("films_style_bounds", sql`${table.styleNotes} IS NULL OR length(${table.styleNotes}) <= 2000`),
]);

/** TypeScript type for a Film row. */
export type Film = typeof films.$inferSelect;

/** TypeScript type for inserting a Film. */
export type NewFilm = typeof films.$inferInsert;
