import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";

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
  budgetLimitUsdMicros: integer("budget_limit_usd_micros")
    .default(0)
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

  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),

  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/** TypeScript type for a Film row. */
export type Film = typeof films.$inferSelect;

/** TypeScript type for inserting a Film. */
export type NewFilm = typeof films.$inferInsert;
