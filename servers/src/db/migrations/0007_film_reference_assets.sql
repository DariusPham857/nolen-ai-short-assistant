CREATE TABLE "film_reference_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"film_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"sha256_hash" varchar(64) NOT NULL,
	"mime_type" varchar(64) NOT NULL,
	"byte_size" bigint NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"label" varchar(120) NOT NULL,
	"source_note" text NOT NULL,
	"license_url" text,
	"rights_confirmed_by" varchar(64) NOT NULL,
	"rights_confirmed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "film_reference_assets_film_id_sha256_hash_unique" UNIQUE("film_id","sha256_hash"),
	CONSTRAINT "film_reference_assets_film_id_id_unique" UNIQUE("film_id","id"),
	CONSTRAINT "reference_asset_mime_valid" CHECK ("film_reference_assets"."mime_type" IN ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "reference_asset_byte_size_positive" CHECK ("film_reference_assets"."byte_size" > 0),
	CONSTRAINT "reference_asset_dimensions_valid" CHECK ("film_reference_assets"."width" >= 300 AND "film_reference_assets"."width" <= 4096 AND "film_reference_assets"."height" >= 300 AND "film_reference_assets"."height" <= 4096 AND ("film_reference_assets"."width" * "film_reference_assets"."height") <= 16777216)
);
--> statement-breakpoint
ALTER TABLE "film_reference_assets" ADD CONSTRAINT "film_reference_assets_film_id_films_id_fk" FOREIGN KEY ("film_id") REFERENCES "public"."films"("id") ON DELETE restrict ON UPDATE no action;
