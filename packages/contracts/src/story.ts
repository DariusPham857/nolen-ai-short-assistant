import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const keys = z.array(key).max(32).refine(v => new Set(v).size === v.length, 'Duplicate reference');
const definition = z.object({ id: key, name: z.string().trim().min(1).max(255), description: text }).strict();
export const bibleSchema = z.object({
  schemaVersion: z.literal('1'), narrative: text,
  characters: z.array(definition).max(32), wardrobes: z.array(definition).max(32),
  props: z.array(definition.extend({ hero: z.boolean().default(false) })).max(32),
  locations: z.array(definition).max(32), styleRefs: z.array(definition).max(32),
}).strict().superRefine((v,c) => {
  for (const group of ['characters','wardrobes','props','locations','styleRefs'] as const) {
    if (new Set(v[group].map(x=>x.id)).size !== v[group].length) c.addIssue({code:'custom',path:[group],message:'Duplicate Bible key'});
  }
});
const characterState = z.object({ characterId: key, wardrobeId: key, pose: text, heldPropIds: keys }).strict();
const continuityState = z.object({ locationId: key, lighting: text, propIds: keys, characterStates: z.array(characterState).max(32) }).strict();
export const shotSpecSchema = z.object({
  schemaVersion:z.literal('1').default('1'),
  shotType: z.enum(['CHARACTER','ACTION','DIALOGUE','ESTABLISHING','BROLL','INSERT','PRODUCT','OTHER']),
  durationSeconds: z.number().int().min(1).max(60), prompt: text, negativePrompt: z.string().max(1000).default(''),
  camera: z.object({framing:text,movement:text}).strict(), styleRefId:key, subjectIds:keys, locationId:key,
  continuity: z.object({start:continuityState,end:continuityState}).strict(),
  intendedTransitions: z.array(z.object({ field:z.enum(['wardrobe','heldProps','pose','location','lighting','props']), reason:text }).strict()).max(6).default([]),
  keyframeOverride: z.object({requirement:z.enum(['REQUIRED','OPTIONAL']),reason:text,riskAcknowledged:z.literal(true)}).strict().nullable().default(null),
}).strict();
const shotInput = z.object({ id:z.string().uuid().optional(), clientRef:key, expectedShotRevisionId:z.string().uuid().optional(), spec:shotSpecSchema }).strict();
export const storyContentSchema = z.object({
  script:z.string().trim().min(1).max(20000), storyBible:bibleSchema,
  scenes:z.array(z.object({id:z.string().uuid().optional(),clientRef:key,title:z.string().trim().min(1).max(255),shots:z.array(shotInput).min(1).max(10)}).strict()).min(1).max(10),
}).strict().superRefine((v,c)=>{
  const shots=v.scenes.flatMap(s=>s.shots);
  if(shots.length>10)c.addIssue({code:'custom',path:['scenes'],message:'At most ten shots'});
  for(const [group,items] of [['scene',v.scenes],['shot',shots]] as const){
    if(new Set(items.map(x=>x.clientRef)).size!==items.length || new Set(items.filter(x=>x.id).map(x=>x.id)).size!==items.filter(x=>x.id).length)
      c.addIssue({code:'custom',message:`Duplicate ${group} identity`});
  }
});
export const expectedSchema = z.object({expectedStoryRevisionId:z.string().uuid().nullable(),expectedStateVersion:z.number().int().min(0)}).strict();
export const saveStorySchema = expectedSchema.extend({content:storyContentSchema}).strict();
export const validateStorySchema = expectedSchema.extend({context:z.enum(['STORY_APPROVAL','VIDEO_DISPATCH']).default('STORY_APPROVAL')}).strict();
export const waiverSchema = expectedSchema.extend({findingFingerprint:z.string().regex(/^[a-f0-9]{64}$/),reason:text}).strict();
export const storyStateSchema = z.enum(['DRAFT','PLANNED','IN_REVIEW','APPROVED']);
export const policySchema = z.object({systemRecommendation:z.enum(['REQUIRED','OPTIONAL']),effectiveRequirement:z.enum(['REQUIRED','OPTIONAL']),riskFlags:z.array(z.string()),ruleSetVersion:z.string()});
export type StoryContent = z.infer<typeof storyContentSchema>;
export type ShotSpec = z.infer<typeof shotSpecSchema>;
export type Expected = z.infer<typeof expectedSchema>;
export type StoryState = z.infer<typeof storyStateSchema>;
export type Policy = z.infer<typeof policySchema>;
export type Finding = { fingerprint:string; code:string; severity:'ERROR'|'WARNING'; path:string; message:string; waivable:boolean };
export type StorySnapshot = { id:string; parentId:string|null; revisionNo:number; state:StoryState; stateVersion:number; contentHash:string; content:StoryContent; shotRevisions:Record<string,{id:string;dependencyHash:string;policy:Policy}> };
export type Validation = {id:string;context:'STORY_APPROVAL';dependencyHash:string;ruleSetVersion:string;findings:Finding[]};
export type Storyboard = {active:StorySnapshot|null; revision:StorySnapshot|null; history:{id:string;revisionNo:number;state:StoryState}[];currentRuleSetVersion:string;validation:Validation|null;waivers:{id:string;findingFingerprint:string;reason:string}[];approval:Record<string,unknown>|null};

/** Canonical local proposal; explicitly a fixture, independent of global execution mode. */
export function canonicalStory(): StoryContent {
  const state={locationId:'room',lighting:'Warm evening',propIds:['lamp'],characterStates:[{characterId:'hero',wardrobeId:'coat',pose:'Standing',heldPropIds:[]}]};
  return storyContentSchema.parse({script:'The Last Light: a fictional adult restores an unbranded lamp.',storyBible:{schemaVersion:'1',narrative:'Quiet cinematic realism',characters:[{id:'hero',name:'Hero',description:'Fictional adult with short dark hair'}],wardrobes:[{id:'coat',name:'Coat',description:'Brown coat'}],props:[{id:'lamp',name:'Lamp',description:'Unbranded desk lamp',hero:true}],locations:[{id:'room',name:'Room',description:'Quiet studio'}],styleRefs:[{id:'cinema',name:'Cinema',description:'Warm realistic light'}]},scenes:[{clientRef:'scene-1',title:'The Last Light',shots:[5,5,6,6,6,6,6,5].map((durationSeconds,i)=>({clientRef:`shot-${i+1}`,spec:{shotType:i===0?'ESTABLISHING':'CHARACTER',durationSeconds,prompt:`Shot ${i+1}: the hero restores the lamp`,camera:{framing:'Medium',movement:'Static'},styleRefId:'cinema',subjectIds:['hero'],locationId:'room',continuity:{start:state,end:state}}}))}]});
}
