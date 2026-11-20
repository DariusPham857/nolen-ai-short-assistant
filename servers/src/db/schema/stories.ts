import { pgTable, uuid, integer, text, jsonb, timestamp, unique, foreignKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { films } from './films.js';

export const storyRevisions = pgTable('story_revisions', {
  id:uuid().primaryKey(), filmId:uuid('film_id').notNull().references(()=>films.id), parentId:uuid('parent_id'),
  revisionNo:integer('revision_no').notNull(), state:text().notNull().default('DRAFT'), stateVersion:integer('state_version').notNull().default(0),
  content:jsonb().notNull(), contentHash:text('content_hash').notNull(), createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[unique().on(t.filmId,t.id),unique().on(t.filmId,t.revisionNo),foreignKey({columns:[t.filmId,t.parentId],foreignColumns:[t.filmId,t.id]}),check('story_state_valid',sql`${t.state} IN ('DRAFT','PLANNED','IN_REVIEW','APPROVED') AND ${t.stateVersion} >= 0`)]);
export const scenes = pgTable('scenes',{id:uuid().primaryKey(),filmId:uuid('film_id').notNull().references(()=>films.id)},t=>[unique().on(t.filmId,t.id)]);
export const shots = pgTable('shots',{id:uuid().primaryKey(),filmId:uuid('film_id').notNull().references(()=>films.id)},t=>[unique().on(t.filmId,t.id)]);
export const shotRevisions = pgTable('shot_revisions',{
  id:uuid().primaryKey(),filmId:uuid('film_id').notNull(),shotId:uuid('shot_id').notNull(),spec:jsonb().notNull(),dependencyHash:text('dependency_hash').notNull(),policy:jsonb().notNull(),
},t=>[unique().on(t.filmId,t.shotId,t.id),foreignKey({columns:[t.filmId,t.shotId],foreignColumns:[shots.filmId,shots.id]})]);
export const storyRevisionScenes = pgTable('story_revision_scenes',{
  filmId:uuid('film_id').notNull(),storyRevisionId:uuid('story_revision_id').notNull(),sceneId:uuid('scene_id').notNull(),position:integer().notNull(),
},t=>[unique().on(t.filmId,t.storyRevisionId,t.sceneId),unique().on(t.storyRevisionId,t.position),foreignKey({columns:[t.filmId,t.storyRevisionId],foreignColumns:[storyRevisions.filmId,storyRevisions.id]}),foreignKey({columns:[t.filmId,t.sceneId],foreignColumns:[scenes.filmId,scenes.id]})]);
export const storyRevisionShots = pgTable('story_revision_shots',{
  filmId:uuid('film_id').notNull(),storyRevisionId:uuid('story_revision_id').notNull(),sceneId:uuid('scene_id').notNull(),shotId:uuid('shot_id').notNull(),shotRevisionId:uuid('shot_revision_id').notNull(),position:integer().notNull(),
},t=>[unique().on(t.storyRevisionId,t.shotId),unique().on(t.storyRevisionId,t.sceneId,t.position),foreignKey({columns:[t.filmId,t.storyRevisionId,t.sceneId],foreignColumns:[storyRevisionScenes.filmId,storyRevisionScenes.storyRevisionId,storyRevisionScenes.sceneId]}),foreignKey({columns:[t.filmId,t.shotId,t.shotRevisionId],foreignColumns:[shotRevisions.filmId,shotRevisions.shotId,shotRevisions.id]})]);
export const validations = pgTable('story_validations',{
  id:uuid().primaryKey(),storyRevisionId:uuid('story_revision_id').notNull().references(()=>storyRevisions.id),context:text().notNull(),dependencyHash:text('dependency_hash').notNull(),ruleSetVersion:text('rule_set_version').notNull(),findings:jsonb().notNull(),
},t=>[unique().on(t.storyRevisionId,t.context,t.dependencyHash,t.ruleSetVersion)]);
export const waivers = pgTable('story_waivers',{
  id:uuid().primaryKey(),storyRevisionId:uuid('story_revision_id').notNull().references(()=>storyRevisions.id),findingFingerprint:text('finding_fingerprint').notNull(),dependencyHash:text('dependency_hash').notNull(),actorId:text('actor_id').notNull(),reason:text().notNull(),createdAt:timestamp('created_at',{withTimezone:true}).notNull().defaultNow(),
},t=>[unique().on(t.storyRevisionId,t.findingFingerprint)]);
export const approvals = pgTable('story_approvals',{
  id:uuid().primaryKey(),storyRevisionId:uuid('story_revision_id').notNull().unique().references(()=>storyRevisions.id),evidence:jsonb().notNull(),
});
export const mutationReceipts = pgTable('story_mutation_receipts',{
  id:uuid().primaryKey(),filmId:uuid('film_id').notNull().references(()=>films.id),operatorId:text('operator_id').notNull(),key:uuid().notNull(),requestHash:text('request_hash').notNull(),response:jsonb().notNull(),
},t=>[unique().on(t.filmId,t.operatorId,t.key)]);
