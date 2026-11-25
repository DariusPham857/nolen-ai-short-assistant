ALTER TABLE "attempts" ADD COLUMN "execution_mode" text;--> statement-breakpoint
UPDATE "attempts"
  SET "execution_mode" = CASE
    WHEN EXISTS (
      SELECT 1 FROM "cost_ledger_events" cle
      WHERE cle."attempt_id" = "attempts"."id"
    ) OR "reservation_usd_micros" > 0 THEN 'LIVE'
    ELSE 'REPLAY'
  END;--> statement-breakpoint
ALTER TABLE "attempts" ALTER COLUMN "execution_mode" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "attempts" ALTER COLUMN "execution_mode" SET DEFAULT 'REPLAY';--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempt_execution_mode_valid" CHECK ("attempts"."execution_mode" IN ('LIVE','REPLAY'));--> statement-breakpoint
ALTER TABLE "outbound_dispatches" DROP CONSTRAINT "outbound_dispatch_state_valid";--> statement-breakpoint
ALTER TABLE "outbound_dispatches" ADD CONSTRAINT "outbound_dispatch_state_valid" CHECK ("outbound_dispatches"."state" IN ('NOT_STARTED','SUBMITTING','SUBMITTED','SUBMISSION_UNCERTAIN','SUCCEEDED','FAILED'));
