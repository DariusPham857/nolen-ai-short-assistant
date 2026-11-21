CREATE TABLE "attempt_financial_state" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"billing_status" text DEFAULT 'PENDING' NOT NULL,
	"reservation_open_usd_micros" bigint NOT NULL,
	"realized_usd_micros" bigint DEFAULT 0 NOT NULL,
	"pending_liability_usd_micros" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempt_billing_status_valid" CHECK ("attempt_financial_state"."billing_status" IN ('PENDING','PARTIAL','FINAL','DISPUTED')),
	CONSTRAINT "attempt_financial_nonnegative" CHECK ("attempt_financial_state"."reservation_open_usd_micros" >= 0 AND "attempt_financial_state"."realized_usd_micros" >= 0 AND "attempt_financial_state"."pending_liability_usd_micros" >= 0 AND "attempt_financial_state"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_id" uuid NOT NULL,
	"story_revision_id" uuid NOT NULL,
	"shot_revision_id" uuid,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"rate_card_snapshot_id" uuid NOT NULL,
	"pricing_units" integer NOT NULL,
	"reservation_usd_micros" bigint NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attempt_kind_valid" CHECK ("attempts"."kind" IN ('IMAGE','VIDEO','TTS','ASSEMBLY')),
	CONSTRAINT "attempt_state_valid" CHECK ("attempts"."state" IN ('QUEUED','SUBMITTED','SUBMISSION_UNCERTAIN','RUNNING','SUCCEEDED','FAILED','CANCELED')),
	CONSTRAINT "attempt_values_valid" CHECK ("attempts"."pricing_units" > 0 AND "attempts"."reservation_usd_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budget_limit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"prior_limit_usd_micros" bigint NOT NULL,
	"new_limit_usd_micros" bigint NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_limit_event_values_nonnegative" CHECK ("budget_limit_events"."prior_limit_usd_micros" >= 0 AND "budget_limit_events"."new_limit_usd_micros" >= 0),
	CONSTRAINT "budget_limit_event_reason_required" CHECK (length(trim("budget_limit_events"."reason")) BETWEEN 1 AND 1000)
);
--> statement-breakpoint
CREATE TABLE "cost_ledger_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"amount_usd_micros" bigint NOT NULL,
	"billing_status" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_event_type_valid" CHECK ("cost_ledger_events"."event_type" IN ('RESERVATION_CREATED','CHARGE_POSTED','RESERVATION_RELEASED','CHARGE_CORRECTED','RESERVATION_ADJUSTED')),
	CONSTRAINT "ledger_billing_status_valid" CHECK ("cost_ledger_events"."billing_status" IN ('PENDING','PARTIAL','FINAL','DISPUTED')),
	CONSTRAINT "ledger_nonzero_correction" CHECK ("cost_ledger_events"."event_type" IN ('CHARGE_CORRECTED','RESERVATION_ADJUSTED') OR "cost_ledger_events"."amount_usd_micros" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dispatch_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"queue_name" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"enqueue_outcome" text DEFAULT 'NOT_ATTEMPTED' NOT NULL,
	"boss_job_id" uuid,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dispatch_outbox_attempt_id_unique" UNIQUE("attempt_id"),
	CONSTRAINT "dispatch_outbox_status_valid" CHECK ("dispatch_outbox"."status" IN ('PENDING','DELIVERING','DELIVERED')),
	CONSTRAINT "dispatch_outcome_valid" CHECK ("dispatch_outbox"."enqueue_outcome" IN ('NOT_ATTEMPTED','JOB_ID','NULL_UNVERIFIED','UNKNOWN_ENQUEUE_OUTCOME','WORKER_CONFIRMED')),
	CONSTRAINT "dispatch_retry_nonnegative" CHECK ("dispatch_outbox"."retry_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "film_budget_accounts" (
	"film_id" uuid PRIMARY KEY NOT NULL,
	"operator_id" text NOT NULL,
	"budget_limit_usd_micros" bigint NOT NULL,
	"actual_spent_usd_micros" bigint DEFAULT 0 NOT NULL,
	"reserved_open_usd_micros" bigint DEFAULT 0 NOT NULL,
	"pending_liability_usd_micros" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "film_budget_projection_nonnegative" CHECK ("film_budget_accounts"."budget_limit_usd_micros" >= 0 AND "film_budget_accounts"."actual_spent_usd_micros" >= 0 AND "film_budget_accounts"."reserved_open_usd_micros" >= 0 AND "film_budget_accounts"."pending_liability_usd_micros" >= 0 AND "film_budget_accounts"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "financial_command_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_id" uuid NOT NULL,
	"operator_id" text NOT NULL,
	"key" uuid NOT NULL,
	"command" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financial_receipt_key" UNIQUE("film_id","operator_id","key")
);
--> statement-breakpoint
CREATE TABLE "outbound_dispatches" (
	"attempt_id" uuid PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'NOT_STARTED' NOT NULL,
	"claim_token" uuid NOT NULL,
	"provider_job_id" text,
	"provider_request_fingerprint" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbound_dispatch_state_valid" CHECK ("outbound_dispatches"."state" IN ('NOT_STARTED','SUBMITTING','SUBMITTED','SUBMISSION_UNCERTAIN'))
);
--> statement-breakpoint
CREATE TABLE "rate_card_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"operation" text NOT NULL,
	"rate_type" text NOT NULL,
	"unit_price_usd_micros" bigint NOT NULL,
	"provider_maximum_usd_micros" bigint,
	"effective_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"source_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rate_card_type_valid" CHECK ("rate_card_snapshots"."rate_type" IN ('FIXED_PER_REQUEST','PER_SECOND')),
	CONSTRAINT "rate_card_values_valid" CHECK ("rate_card_snapshots"."unit_price_usd_micros" >= 0 AND ("rate_card_snapshots"."provider_maximum_usd_micros" IS NULL OR "rate_card_snapshots"."provider_maximum_usd_micros" >= 0) AND "rate_card_snapshots"."expires_at" > "rate_card_snapshots"."effective_at")
);
--> statement-breakpoint
ALTER TABLE "attempt_financial_state" ADD CONSTRAINT "attempt_financial_state_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shot_revisions" ADD CONSTRAINT "shot_revisions_film_id_id_unique" UNIQUE("film_id","id");--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_story_revision_id_story_revisions_id_fk" FOREIGN KEY ("story_revision_id") REFERENCES "public"."story_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_shot_revision_id_shot_revisions_id_fk" FOREIGN KEY ("shot_revision_id") REFERENCES "public"."shot_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_rate_card_snapshot_id_rate_card_snapshots_id_fk" FOREIGN KEY ("rate_card_snapshot_id") REFERENCES "public"."rate_card_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_film_id_story_revision_id_story_revisions_film_id_id_fk" FOREIGN KEY ("film_id","story_revision_id") REFERENCES "public"."story_revisions"("film_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_film_id_shot_revision_id_shot_revisions_film_id_id_fk" FOREIGN KEY ("film_id","shot_revision_id") REFERENCES "public"."shot_revisions"("film_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_limit_events" ADD CONSTRAINT "budget_limit_events_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_ledger_events" ADD CONSTRAINT "cost_ledger_events_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_ledger_events" ADD CONSTRAINT "cost_ledger_events_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_outbox" ADD CONSTRAINT "dispatch_outbox_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "film_budget_accounts" ADD CONSTRAINT "film_budget_accounts_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_command_receipts" ADD CONSTRAINT "financial_command_receipts_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_dispatches" ADD CONSTRAINT "outbound_dispatches_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO film_budget_accounts(film_id,operator_id,budget_limit_usd_micros)
SELECT id,operator_id,budget_limit_usd_micros FROM films
ON CONFLICT (film_id) DO NOTHING;
--> statement-breakpoint
INSERT INTO budget_limit_events(id,film_id,actor_id,prior_limit_usd_micros,new_limit_usd_micros,reason,created_at)
SELECT gen_random_uuid(),f.id,f.operator_id,f.budget_limit_usd_micros,f.budget_limit_usd_micros,'FI-001 migration baseline',f.created_at
FROM films f
WHERE NOT EXISTS (SELECT 1 FROM budget_limit_events e WHERE e.film_id=f.id);
--> statement-breakpoint
CREATE FUNCTION fi_guard_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'FI_APPEND_ONLY'; END $$;
--> statement-breakpoint
CREATE TRIGGER fi_budget_limit_events_append_only BEFORE UPDATE OR DELETE ON budget_limit_events FOR EACH ROW EXECUTE FUNCTION fi_guard_append_only();
--> statement-breakpoint
CREATE TRIGGER fi_cost_ledger_events_append_only BEFORE UPDATE OR DELETE ON cost_ledger_events FOR EACH ROW EXECUTE FUNCTION fi_guard_append_only();
--> statement-breakpoint
CREATE TRIGGER fi_rate_card_snapshots_append_only BEFORE UPDATE OR DELETE ON rate_card_snapshots FOR EACH ROW EXECUTE FUNCTION fi_guard_append_only();
--> statement-breakpoint
CREATE TRIGGER fi_financial_receipts_append_only BEFORE UPDATE OR DELETE ON financial_command_receipts FOR EACH ROW EXECUTE FUNCTION fi_guard_append_only();
