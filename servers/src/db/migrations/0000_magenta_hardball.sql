CREATE TYPE "public"."aspect_ratio" AS ENUM('9:16', '16:9', '1:1', '4:5');--> statement-breakpoint
CREATE TYPE "public"."film_status" AS ENUM('DRAFT', 'PLANNING', 'IN_PRODUCTION', 'COMPLETED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "films" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(255) NOT NULL,
	"brief" text NOT NULL,
	"status" "film_status" DEFAULT 'DRAFT' NOT NULL,
	"budget_limit_usd_micros" bigint DEFAULT 0 NOT NULL,
	"duration_target_seconds" integer DEFAULT 30 NOT NULL,
	"aspect_ratio" "aspect_ratio" DEFAULT '9:16' NOT NULL,
	"style_notes" text,
	"active_story_revision_id" uuid,
	"operator_id" varchar(64) NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "films_budget_nonnegative" CHECK ("films"."budget_limit_usd_micros" >= 0),
	CONSTRAINT "films_duration_bounds" CHECK ("films"."duration_target_seconds" BETWEEN 30 AND 60),
	CONSTRAINT "films_title_required" CHECK (length(trim("films"."title")) > 0),
	CONSTRAINT "films_brief_bounds" CHECK (length(trim("films"."brief")) BETWEEN 1 AND 10000),
	CONSTRAINT "films_style_bounds" CHECK ("films"."style_notes" IS NULL OR length("films"."style_notes") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "operator_sessions" (
	"session_hash" varchar(64) PRIMARY KEY NOT NULL,
	"operator_id" varchar(64) NOT NULL,
	"token_fingerprint" varchar(64) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "films_operator_idempotency" ON "films" USING btree ("operator_id","idempotency_key");