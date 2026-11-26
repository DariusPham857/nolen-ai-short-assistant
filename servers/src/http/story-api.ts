import { Hono } from 'hono';
import { canonicalStoryV2, expectedSchema, planProposalRequestSchema, saveStorySchema, validateStorySchema, waiverSchema } from '@nolen/contracts';
import { pgClient } from '../db/index.js';
import { command, readStoryboard } from '../stories/repository.js';
import { generateGeminiStoryProposal, type FreePlannerProposalResult } from '../stories/free-planner.js';
import { ApiFailure } from './errors.js';
import { boundedJson, installBoundary, keySchema, requireOperator, resourceId } from './boundary.js';

type StorySnapshotRow = {
  id: string;
  brief: string;
  duration_target_seconds: number;
  aspect_ratio: string;
  active_story_revision_id: string | null;
  state_version: number | null;
};

async function readFilmPlannerSnapshot(filmId: string, operator: string): Promise<StorySnapshotRow | undefined> {
  const [row] = await pgClient<StorySnapshotRow[]>`
    SELECT f.id, f.brief, f.duration_target_seconds, f.aspect_ratio, f.active_story_revision_id, r.state_version
    FROM films f
    LEFT JOIN story_revisions r ON r.id = f.active_story_revision_id
    WHERE f.id = ${filmId} AND f.operator_id = ${operator}
  `;
  return row;
}

export type StoryApiDeps = {
  generateGeminiProposal?: (input: {
    brief: string;
    durationTargetSeconds: number;
    aspectRatio: string;
  }) => Promise<FreePlannerProposalResult>;
};

/** Story routes use the same security boundary as Film, including standalone Hono invocation. */
export function createStoryApi(deps: StoryApiDeps = {}){
  const generateProposal = deps.generateGeminiProposal ?? (input => generateGeminiStoryProposal(input));
  const api=new Hono();installBoundary(api);
  api.get('/api/films/:filmId/storyboard',async c=>{const operator=await requireOperator(c);return c.json(await readStoryboard(resourceId(c.req.param('filmId')),operator));});
  api.get('/api/films/:filmId/storyboard/revisions/:revisionId',async c=>{const operator=await requireOperator(c);return c.json(await readStoryboard(resourceId(c.req.param('filmId')),operator,resourceId(c.req.param('revisionId'))));});
  for(const kind of ['revisions','mark-planned','submit-review','approve','waivers','plan-proposals','validate'] as const){
    const route=kind==='validate'?'/api/films/:filmId/continuity/validate':`/api/films/:filmId/storyboard/${kind}`;
    api.post(route,async c=>{
      const operator=await requireOperator(c);const filmId=resourceId(c.req.param('filmId'));
      const body=await boundedJson(c.req.raw,524288);
      if(kind==='plan-proposals'){
        const input=planProposalRequestSchema.parse(body);
        if(input.mode==='FIXTURE'){
          const [film]=await pgClient`SELECT id FROM films WHERE id=${filmId} AND operator_id=${operator}`;
          if(!film)throw new ApiFailure(404,'FILM_NOT_FOUND','Film not found');
          return c.json({provenance:{source:'FIXTURE',fixtureId:'the-last-light-45s-v2',liveInference:false},content:canonicalStoryV2()});
        }
        const before=await readFilmPlannerSnapshot(filmId,operator);
        if(!before)throw new ApiFailure(404,'FILM_NOT_FOUND','Film not found');
        if((before.active_story_revision_id??null)!==input.expectedStoryRevisionId || (before.state_version??0)!==input.expectedStateVersion){
          throw new ApiFailure(409,'VERSION_CONFLICT','Reload the current storyboard before generating a proposal');
        }
        const proposal=await generateProposal({
          brief:before.brief,
          durationTargetSeconds:before.duration_target_seconds,
          aspectRatio:before.aspect_ratio,
        });
        const after=await readFilmPlannerSnapshot(filmId,operator);
        if(!after)throw new ApiFailure(404,'FILM_NOT_FOUND','Film not found');
        if(
          after.brief!==before.brief ||
          after.duration_target_seconds!==before.duration_target_seconds ||
          after.aspect_ratio!==before.aspect_ratio ||
          (after.active_story_revision_id??null)!==(before.active_story_revision_id??null) ||
          (after.state_version??0)!==(before.state_version??0)
        ){
          throw new ApiFailure(409,'VERSION_CONFLICT','Film or story changed while generating proposal');
        }
        return c.json(proposal);
      }
      if(kind==='validate'){
        const input=validateStorySchema.parse(body);
        if(input.context!=='STORY_APPROVAL')throw new ApiFailure(422,'VALIDATION_CONTEXT_NOT_IMPLEMENTED','VIDEO_DISPATCH is not implemented');
        return c.json(await command(filmId,operator,null,'validate',expectedSchema.parse({expectedStoryRevisionId:input.expectedStoryRevisionId,expectedStateVersion:input.expectedStateVersion})));
      }
      const key=keySchema.safeParse(c.req.header('Idempotency-Key'));
      if(!key.success)throw new ApiFailure(400,'IDEMPOTENCY_KEY_REQUIRED','Use a UUID-v4 Idempotency-Key');
      const input=kind==='revisions'?saveStorySchema.parse(body):kind==='waivers'?waiverSchema.parse(body):expectedSchema.parse(body);
      return c.json(await command(filmId,operator,key.data,kind==='revisions'?'save':kind==='waivers'?'waiver':kind,input),kind==='revisions'?201:200);
    });
    api.all(route,c=>{c.header('Allow','POST');throw new ApiFailure(405,'METHOD_NOT_ALLOWED','Use POST');});
  }
  for(const route of ['/api/films/:filmId/storyboard','/api/films/:filmId/storyboard/revisions/:revisionId'])api.all(route,c=>{c.header('Allow','GET');throw new ApiFailure(405,'METHOD_NOT_ALLOWED','Use GET');});
  return api;
}
