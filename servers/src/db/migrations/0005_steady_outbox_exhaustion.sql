ALTER TABLE "dispatch_outbox" DROP CONSTRAINT "dispatch_outbox_status_valid";--> statement-breakpoint
ALTER TABLE "dispatch_outbox" ADD CONSTRAINT "dispatch_outbox_status_valid" CHECK ("dispatch_outbox"."status" IN ('PENDING','DELIVERING','DELIVERED','EXHAUSTED'));--> statement-breakpoint
ALTER TABLE "dispatch_outbox" ADD COLUMN "exhausted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dispatch_outbox" ADD COLUMN "last_error" text;
