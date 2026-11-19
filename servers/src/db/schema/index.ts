/**
 * Database schema barrel export.
 *
 * Domain model hierarchy (DEC-P04):
 *   Film → StoryRevision → Scene → Shot → ShotRevision → Attempt → Asset → AssetReview
 *
 * Each domain entity gets its own schema file.
 * Tables are defined here; migration files are generated via `pnpm db:generate`.
 */

export * from "./films.js";
// Future schema exports (EP-01, EP-02):
// export * from "./story-revisions.js";
// export * from "./scenes.js";
// export * from "./shots.js";
// export * from "./shot-revisions.js";
// export * from "./attempts.js";
// export * from "./assets.js";
// export * from "./asset-reviews.js";
// export * from "./cost-ledger.js";
// export * from "./usage-manifest.js";
