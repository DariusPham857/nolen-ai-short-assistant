CREATE TABLE "asset_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"film_id" uuid NOT NULL,
	"shot_revision_id" uuid NOT NULL,
	"actor_id" varchar(64) NOT NULL,
	"decision" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_review_decision_valid" CHECK ("asset_reviews"."decision" IN ('APPROVED', 'REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"shot_revision_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_path" text NOT NULL,
	"sha256_hash" varchar(64) NOT NULL,
	"mime_type" varchar(64) NOT NULL,
	"byte_size" bigint NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_attempt_id_unique" UNIQUE("attempt_id"),
	CONSTRAINT "assets_film_id_id_unique" UNIQUE("film_id","id"),
	CONSTRAINT "asset_kind_valid" CHECK ("assets"."kind" IN ('IMAGE', 'VIDEO')),
	CONSTRAINT "asset_byte_size_nonnegative" CHECK ("assets"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "shot_asset_selections" (
	"story_revision_id" uuid NOT NULL,
	"shot_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"shot_revision_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"film_id" uuid NOT NULL,
	"selected_by" varchar(64) NOT NULL,
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shot_asset_selections_story_revision_id_shot_id_kind_unique" UNIQUE("story_revision_id","shot_id","kind"),
	CONSTRAINT "shot_asset_selection_kind_valid" CHECK ("shot_asset_selections"."kind" IN ('IMAGE', 'VIDEO'))
);
--> statement-breakpoint
ALTER TABLE "asset_reviews" ADD CONSTRAINT "asset_reviews_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_reviews" ADD CONSTRAINT "asset_reviews_film_id_asset_id_assets_film_id_id_fk" FOREIGN KEY ("film_id","asset_id") REFERENCES "public"."assets"("film_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_reviews" ADD CONSTRAINT "asset_reviews_film_id_shot_revision_id_shot_revisions_film_id_id_fk" FOREIGN KEY ("film_id","shot_revision_id") REFERENCES "public"."shot_revisions"("film_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_film_id_shot_revision_id_shot_revisions_film_id_id_fk" FOREIGN KEY ("film_id","shot_revision_id") REFERENCES "public"."shot_revisions"("film_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shot_asset_selections" ADD CONSTRAINT "shot_asset_selections_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shot_asset_selections" ADD CONSTRAINT "shot_asset_selections_story_revision_id_shot_id_story_revision_shots_story_revision_id_shot_id_fk" FOREIGN KEY ("story_revision_id","shot_id") REFERENCES "public"."story_revision_shots"("story_revision_id","shot_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shot_asset_selections" ADD CONSTRAINT "shot_asset_selections_film_id_asset_id_assets_film_id_id_fk" FOREIGN KEY ("film_id","asset_id") REFERENCES "public"."assets"("film_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shot_asset_selections" ADD CONSTRAINT "shot_asset_selections_film_id_shot_revision_id_shot_revisions_film_id_id_fk" FOREIGN KEY ("film_id","shot_revision_id") REFERENCES "public"."shot_revisions"("film_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_film_id_shot_revision_id_kind_id_unique" UNIQUE("film_id","shot_revision_id","kind","id");--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_film_shot_kind_attempt_fk" FOREIGN KEY ("film_id","shot_revision_id","kind","attempt_id") REFERENCES "public"."attempts"("film_id","shot_revision_id","kind","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_reviews_latest_idx" ON "asset_reviews" USING btree ("asset_id","created_at","id");--> statement-breakpoint
CREATE FUNCTION kf_guard_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'KF_APPEND_ONLY'; END $$;--> statement-breakpoint
CREATE TRIGGER kf_asset_reviews_append_only BEFORE UPDATE OR DELETE ON asset_reviews FOR EACH ROW EXECUTE FUNCTION kf_guard_append_only();
