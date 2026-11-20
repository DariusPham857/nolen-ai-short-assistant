CREATE TABLE "story_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"story_revision_id" uuid NOT NULL,
	"evidence" jsonb NOT NULL,
	CONSTRAINT "story_approvals_story_revision_id_unique" UNIQUE("story_revision_id")
);
--> statement-breakpoint
CREATE TABLE "story_mutation_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_id" uuid NOT NULL,
	"operator_id" text NOT NULL,
	"key" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	CONSTRAINT "story_mutation_receipts_film_id_operator_id_key_unique" UNIQUE("film_id","operator_id","key")
);
--> statement-breakpoint
CREATE TABLE "scenes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_id" uuid NOT NULL,
	CONSTRAINT "scenes_film_id_id_unique" UNIQUE("film_id","id")
);
--> statement-breakpoint
CREATE TABLE "shot_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_id" uuid NOT NULL,
	"shot_id" uuid NOT NULL,
	"spec" jsonb NOT NULL,
	"dependency_hash" text NOT NULL,
	"policy" jsonb NOT NULL,
	CONSTRAINT "shot_revisions_film_id_shot_id_id_unique" UNIQUE("film_id","shot_id","id")
);
--> statement-breakpoint
CREATE TABLE "shots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_id" uuid NOT NULL,
	CONSTRAINT "shots_film_id_id_unique" UNIQUE("film_id","id")
);
--> statement-breakpoint
CREATE TABLE "story_revision_scenes" (
	"film_id" uuid NOT NULL,
	"story_revision_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "story_revision_scenes_film_id_story_revision_id_scene_id_unique" UNIQUE("film_id","story_revision_id","scene_id"),
	CONSTRAINT "story_revision_scenes_story_revision_id_position_unique" UNIQUE("story_revision_id","position")
);
--> statement-breakpoint
CREATE TABLE "story_revision_shots" (
	"film_id" uuid NOT NULL,
	"story_revision_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"shot_id" uuid NOT NULL,
	"shot_revision_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "story_revision_shots_story_revision_id_shot_id_unique" UNIQUE("story_revision_id","shot_id"),
	CONSTRAINT "story_revision_shots_story_revision_id_scene_id_position_unique" UNIQUE("story_revision_id","scene_id","position")
);
--> statement-breakpoint
CREATE TABLE "story_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_id" uuid NOT NULL,
	"parent_id" uuid,
	"revision_no" integer NOT NULL,
	"state" text DEFAULT 'DRAFT' NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_revisions_film_id_id_unique" UNIQUE("film_id","id"),
	CONSTRAINT "story_revisions_film_id_revision_no_unique" UNIQUE("film_id","revision_no"),
	CONSTRAINT "story_state_valid" CHECK ("story_revisions"."state" IN ('DRAFT','PLANNED','IN_REVIEW','APPROVED') AND "story_revisions"."state_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "story_validations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"story_revision_id" uuid NOT NULL,
	"context" text NOT NULL,
	"dependency_hash" text NOT NULL,
	"rule_set_version" text NOT NULL,
	"findings" jsonb NOT NULL,
	CONSTRAINT "story_validations_story_revision_id_context_dependency_hash_rule_set_version_unique" UNIQUE("story_revision_id","context","dependency_hash","rule_set_version")
);
--> statement-breakpoint
CREATE TABLE "story_waivers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"story_revision_id" uuid NOT NULL,
	"finding_fingerprint" text NOT NULL,
	"dependency_hash" text NOT NULL,
	"actor_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "story_waivers_story_revision_id_finding_fingerprint_unique" UNIQUE("story_revision_id","finding_fingerprint")
);
--> statement-breakpoint
ALTER TABLE "films" ADD COLUMN "create_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "story_approvals" ADD CONSTRAINT "story_approvals_story_revision_id_story_revisions_id_fk" FOREIGN KEY ("story_revision_id") REFERENCES "public"."story_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_mutation_receipts" ADD CONSTRAINT "story_mutation_receipts_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shot_revisions" ADD CONSTRAINT "shot_revisions_film_id_shot_id_shots_film_id_id_fk" FOREIGN KEY ("film_id","shot_id") REFERENCES "public"."shots"("film_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shots" ADD CONSTRAINT "shots_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_revision_scenes" ADD CONSTRAINT "story_revision_scenes_film_id_story_revision_id_story_revisions_film_id_id_fk" FOREIGN KEY ("film_id","story_revision_id") REFERENCES "public"."story_revisions"("film_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_revision_scenes" ADD CONSTRAINT "story_revision_scenes_film_id_scene_id_scenes_film_id_id_fk" FOREIGN KEY ("film_id","scene_id") REFERENCES "public"."scenes"("film_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_revision_shots" ADD CONSTRAINT "story_revision_shots_film_id_story_revision_id_scene_id_story_revision_scenes_film_id_story_revision_id_scene_id_fk" FOREIGN KEY ("film_id","story_revision_id","scene_id") REFERENCES "public"."story_revision_scenes"("film_id","story_revision_id","scene_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_revision_shots" ADD CONSTRAINT "story_revision_shots_film_id_shot_id_shot_revision_id_shot_revisions_film_id_shot_id_id_fk" FOREIGN KEY ("film_id","shot_id","shot_revision_id") REFERENCES "public"."shot_revisions"("film_id","shot_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_revisions" ADD CONSTRAINT "story_revisions_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_revisions" ADD CONSTRAINT "story_revisions_film_id_parent_id_story_revisions_film_id_id_fk" FOREIGN KEY ("film_id","parent_id") REFERENCES "public"."story_revisions"("film_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_validations" ADD CONSTRAINT "story_validations_story_revision_id_story_revisions_id_fk" FOREIGN KEY ("story_revision_id") REFERENCES "public"."story_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_waivers" ADD CONSTRAINT "story_waivers_story_revision_id_story_revisions_id_fk" FOREIGN KEY ("story_revision_id") REFERENCES "public"."story_revisions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM films WHERE status <> 'DRAFT' OR active_story_revision_id IS NOT NULL OR updated_at <> created_at OR aspect_ratio <> '9:16') THEN
  RAISE EXCEPTION 'UNSUPPORTED_LEGACY_FILM: cannot reconstruct original create receipt';
 END IF;
END $$;
--> statement-breakpoint
UPDATE films SET create_receipt=jsonb_build_object(
 'id',id,'title',title,'brief',brief,'budgetLimitUsdMicros',budget_limit_usd_micros::text,
 'durationTargetSeconds',duration_target_seconds,'aspectRatio',aspect_ratio,'styleNotes',style_notes,
 'status',status,'activeStoryRevisionId',NULL,
 'createdAt',to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'updatedAt',to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
--> statement-breakpoint
ALTER TABLE films ADD CONSTRAINT films_active_story_same_film FOREIGN KEY(id,active_story_revision_id) REFERENCES story_revisions(film_id,id);
--> statement-breakpoint
CREATE FUNCTION sp_guard_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_HISTORY' USING ERRCODE='23514'; END $$;
--> statement-breakpoint
CREATE FUNCTION sp_guard_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'IMMUTABLE_HISTORY' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-'state'-'state_version') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'state_version') THEN
  RAISE EXCEPTION 'IMMUTABLE_CREATIVE_CONTENT' USING ERRCODE='23514';
 END IF;
 IF OLD.state='APPROVED' OR NEW.state_version <> OLD.state_version+1 OR NOT (
  (OLD.state=NEW.state AND OLD.state IN ('PLANNED','IN_REVIEW')) OR
  (OLD.state='DRAFT' AND NEW.state='PLANNED') OR
  (OLD.state='PLANNED' AND NEW.state='IN_REVIEW') OR
  (OLD.state='IN_REVIEW' AND NEW.state='APPROVED')) THEN
  RAISE EXCEPTION 'INVALID_STORY_TRANSITION' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION sp_guard_waiver() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_state text;
BEGIN
 PERFORM 1 FROM films f JOIN story_revisions r ON r.film_id=f.id WHERE r.id=NEW.story_revision_id FOR UPDATE OF f;
 SELECT state INTO current_state FROM story_revisions WHERE id=NEW.story_revision_id;
 IF current_state NOT IN ('PLANNED','IN_REVIEW') OR NOT EXISTS(SELECT 1 FROM films WHERE active_story_revision_id=NEW.story_revision_id) THEN
  RAISE EXCEPTION 'WAIVER_NOT_ALLOWED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sp_revision_guard BEFORE UPDATE OR DELETE ON story_revisions FOR EACH ROW EXECUTE FUNCTION sp_guard_revision();
--> statement-breakpoint
CREATE TRIGGER sp_waiver_insert_guard BEFORE INSERT ON story_waivers FOR EACH ROW EXECUTE FUNCTION sp_guard_waiver();

--> statement-breakpoint
CREATE TRIGGER sp_scenes_immutable BEFORE UPDATE OR DELETE ON scenes FOR EACH ROW EXECUTE FUNCTION sp_guard_immutable();

--> statement-breakpoint
CREATE TRIGGER sp_shots_immutable BEFORE UPDATE OR DELETE ON shots FOR EACH ROW EXECUTE FUNCTION sp_guard_immutable();

--> statement-breakpoint
CREATE TRIGGER sp_shot_revisions_immutable BEFORE UPDATE OR DELETE ON shot_revisions FOR EACH ROW EXECUTE FUNCTION sp_guard_immutable();

--> statement-breakpoint
CREATE TRIGGER sp_story_revision_scenes_immutable BEFORE UPDATE OR DELETE ON story_revision_scenes FOR EACH ROW EXECUTE FUNCTION sp_guard_immutable();

--> statement-breakpoint
CREATE TRIGGER sp_story_revision_shots_immutable BEFORE UPDATE OR DELETE ON story_revision_shots FOR EACH ROW EXECUTE FUNCTION sp_guard_immutable();

--> statement-breakpoint
CREATE TRIGGER sp_story_validations_immutable BEFORE UPDATE OR DELETE ON story_validations FOR EACH ROW EXECUTE FUNCTION sp_guard_immutable();

--> statement-breakpoint
CREATE TRIGGER sp_story_waivers_immutable BEFORE UPDATE OR DELETE ON story_waivers FOR EACH ROW EXECUTE FUNCTION sp_guard_immutable();

--> statement-breakpoint
CREATE TRIGGER sp_story_approvals_immutable BEFORE UPDATE OR DELETE ON story_approvals FOR EACH ROW EXECUTE FUNCTION sp_guard_immutable();

--> statement-breakpoint
CREATE TRIGGER sp_story_mutation_receipts_immutable BEFORE UPDATE OR DELETE ON story_mutation_receipts FOR EACH ROW EXECUTE FUNCTION sp_guard_immutable();
