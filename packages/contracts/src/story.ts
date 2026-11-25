import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
const key = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const keys = z.array(key).max(32).refine(v => new Set(v).size === v.length, 'Duplicate reference');
const refAssetIds = z.array(z.string().uuid()).max(16).refine(v => new Set(v).size === v.length, 'Duplicate reference asset').default([]);

const definitionV1 = z.object({ id: key, name: z.string().trim().min(1).max(255), description: text }).strict();
const definitionV2 = definitionV1.extend({ referenceAssetIds: refAssetIds }).strict();

export const bibleV1Schema = z.object({
  schemaVersion: z.literal('1'), narrative: text,
  characters: z.array(definitionV1).max(32), wardrobes: z.array(definitionV1).max(32),
  props: z.array(definitionV1.extend({ hero: z.boolean().default(false) })).max(32),
  locations: z.array(definitionV1).max(32), styleRefs: z.array(definitionV1).max(32),
}).strict().superRefine((v,c) => {
  for (const group of ['characters','wardrobes','props','locations','styleRefs'] as const) {
    if (new Set(v[group].map(x=>x.id)).size !== v[group].length) c.addIssue({code:'custom',path:[group],message:'Duplicate Bible key'});
  }
});

export const bibleV2Schema = z.object({
  schemaVersion: z.literal('2'), narrative: text,
  characters: z.array(definitionV2).max(32), wardrobes: z.array(definitionV2).max(32),
  props: z.array(definitionV2.extend({ hero: z.boolean().default(false) })).max(32),
  locations: z.array(definitionV2).max(32), styleRefs: z.array(definitionV2).max(32),
}).strict().superRefine((v,c) => {
  for (const group of ['characters','wardrobes','props','locations','styleRefs'] as const) {
    if (new Set(v[group].map(x=>x.id)).size !== v[group].length) c.addIssue({code:'custom',path:[group],message:'Duplicate Bible key'});
  }
});

export const bibleSchema = z.union([bibleV2Schema, bibleV1Schema]);
export type StoryBibleV1 = z.infer<typeof bibleV1Schema>;
export type StoryBibleV2 = z.infer<typeof bibleV2Schema>;
export type StoryBible = z.infer<typeof bibleSchema>;
export type BibleGroup = 'characters' | 'wardrobes' | 'props' | 'locations' | 'styleRefs';

export const cameraAngleSchema = z.enum([
  'EYE_LEVEL',
  'HIGH_ANGLE',
  'LOW_ANGLE',
  'OVERHEAD',
  'DUTCH_ANGLE',
  'POV',
  'OVER_THE_SHOULDER',
]);
export type CameraAngle = z.infer<typeof cameraAngleSchema>;

const characterState = z.object({ characterId: key, wardrobeId: key, pose: text, heldPropIds: keys }).strict();
const continuityState = z.object({ locationId: key, lighting: text, propIds: keys, characterStates: z.array(characterState).max(32) }).strict();

const shotSpecBaseFields = {
  shotType: z.enum(['CHARACTER','ACTION','DIALOGUE','ESTABLISHING','BROLL','INSERT','PRODUCT','OTHER']),
  durationSeconds: z.number().int().min(1).max(60), prompt: text, negativePrompt: z.string().max(1000).default(''),
  styleRefId: key, subjectIds: keys, locationId: key,
  continuity: z.object({start:continuityState,end:continuityState}).strict(),
  intendedTransitions: z.array(z.object({ field:z.enum(['wardrobe','heldProps','pose','location','lighting','props']), reason:text }).strict()).max(6).default([]),
  keyframeOverride: z.object({requirement:z.enum(['REQUIRED','OPTIONAL']),reason:text,riskAcknowledged:z.literal(true)}).strict().nullable().default(null),
};

export const shotSpecV1Schema = z.object({
  schemaVersion: z.literal('1').default('1'),
  ...shotSpecBaseFields,
  camera: z.object({framing:text,movement:text}).strict(),
}).strict();

export const shotSpecV2Schema = z.object({
  schemaVersion: z.literal('2'),
  ...shotSpecBaseFields,
  camera: z.object({angle: cameraAngleSchema, framing: text, movement: text}).strict(),
}).strict();

export const shotSpecSchema = z.union([shotSpecV2Schema, shotSpecV1Schema]);
export type ShotSpecV1 = z.infer<typeof shotSpecV1Schema>;
export type ShotSpecV2 = z.infer<typeof shotSpecV2Schema>;
export type ShotSpec = z.infer<typeof shotSpecSchema>;

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
export type StoryContentV1 = Omit<StoryContent, 'storyBible' | 'scenes'> & {
  storyBible: StoryBibleV1;
  scenes: Array<Omit<StoryContent['scenes'][number], 'shots'> & {
    shots: Array<Omit<StoryContent['scenes'][number]['shots'][number], 'spec'> & { spec: ShotSpecV1 }>;
  }>;
};
export type StoryContentV2 = Omit<StoryContent, 'storyBible' | 'scenes'> & {
  storyBible: StoryBibleV2;
  scenes: Array<Omit<StoryContent['scenes'][number], 'shots'> & {
    shots: Array<Omit<StoryContent['scenes'][number]['shots'][number], 'spec'> & { spec: ShotSpecV2 }>;
  }>;
};
export type Expected = z.infer<typeof expectedSchema>;
export type StoryState = z.infer<typeof storyStateSchema>;
export type Policy = z.infer<typeof policySchema>;
export type Finding = { fingerprint:string; code:string; severity:'ERROR'|'WARNING'; path:string; message:string; waivable:boolean };
export type StorySnapshot = { id:string; parentId:string|null; revisionNo:number; state:StoryState; stateVersion:number; contentHash:string; content:StoryContent; shotRevisions:Record<string,{id:string;dependencyHash:string;policy:Policy}> };
export type Validation = {id:string;context:'STORY_APPROVAL';dependencyHash:string;ruleSetVersion:string;findings:Finding[]};
export type Storyboard = {active:StorySnapshot|null; revision:StorySnapshot|null; history:{id:string;revisionNo:number;state:StoryState}[];currentRuleSetVersion:string;validation:Validation|null;waivers:{id:string;findingFingerprint:string;reason:string}[];approval:Record<string,unknown>|null};

/** Create a schema-validated ShotSpec v2 with explicit camera angle. */
export function createShotSpecV2(input: z.input<typeof shotSpecV2Schema> | Omit<z.input<typeof shotSpecV2Schema>, 'schemaVersion'>): ShotSpecV2 {
  return shotSpecV2Schema.parse({ ...input, schemaVersion: '2' });
}

/** Upgrade a Story Bible to v2 without mutating existing definitions; optionally bind an initial reference asset. */
export function upgradeBibleToV2(
  bible: StoryBible,
  initialBinding?: { group: BibleGroup; id: string; assetId: string },
): StoryBibleV2 {
  const toV2Def = <T extends { id: string; name: string; description: string; referenceAssetIds?: string[] }>(
    group: BibleGroup,
    def: T,
  ) => {
    const existing = def.referenceAssetIds ?? [];
    const nextIds =
      initialBinding && initialBinding.group === group && initialBinding.id === def.id && !existing.includes(initialBinding.assetId)
        ? [...existing, initialBinding.assetId]
        : [...existing];
    return { ...def, referenceAssetIds: nextIds };
  };

  return bibleV2Schema.parse({
    schemaVersion: '2',
    narrative: bible.narrative,
    characters: bible.characters.map(d => toV2Def('characters', d)),
    wardrobes: bible.wardrobes.map(d => toV2Def('wardrobes', d)),
    props: bible.props.map(d => toV2Def('props', d)),
    locations: bible.locations.map(d => toV2Def('locations', d)),
    styleRefs: bible.styleRefs.map(d => toV2Def('styleRefs', d)),
  });
}

/** Canonical historical v1 proposal retained solely for legacy regression tests. */
export function canonicalStoryV1(): StoryContentV1 {
  const state={locationId:'room',lighting:'Warm evening',propIds:['lamp'],characterStates:[{characterId:'hero',wardrobeId:'coat',pose:'Standing',heldPropIds:[]}]};
  return storyContentSchema.parse({script:'The Last Light: a fictional adult restores an unbranded lamp.',storyBible:{schemaVersion:'1',narrative:'Quiet cinematic realism',characters:[{id:'hero',name:'Hero',description:'Fictional adult with short dark hair'}],wardrobes:[{id:'coat',name:'Coat',description:'Brown coat'}],props:[{id:'lamp',name:'Lamp',description:'Unbranded desk lamp',hero:true}],locations:[{id:'room',name:'Room',description:'Quiet studio'}],styleRefs:[{id:'cinema',name:'Cinema',description:'Warm realistic light'}]},scenes:[{clientRef:'scene-1',title:'The Last Light',shots:[5,5,6,6,6,6,6,5].map((durationSeconds,i)=>({clientRef:`shot-${i+1}`,spec:{shotType:i===0?'ESTABLISHING':'CHARACTER',durationSeconds,prompt:`Shot ${i+1}: the hero restores the lamp`,camera:{framing:'Medium',movement:'Static'},styleRefId:'cinema',subjectIds:['hero'],locationId:'room',continuity:{start:state,end:state}}}))}]}) as StoryContentV1;
}

/** Canonical v2 proposal used by production fixture planner and v2 tests. */
export function canonicalStoryV2(): StoryContentV2 {
  const state={locationId:'room',lighting:'Warm evening',propIds:['lamp'],characterStates:[{characterId:'hero',wardrobeId:'coat',pose:'Standing',heldPropIds:[]}]};
  return storyContentSchema.parse({
    script:'The Last Light: a fictional adult restores an unbranded lamp.',
    storyBible:{
      schemaVersion:'2',
      narrative:'Quiet cinematic realism',
      characters:[{id:'hero',name:'Hero',description:'Fictional adult with short dark hair',referenceAssetIds:[]}],
      wardrobes:[{id:'coat',name:'Coat',description:'Brown coat',referenceAssetIds:[]}],
      props:[{id:'lamp',name:'Lamp',description:'Unbranded desk lamp',hero:true,referenceAssetIds:[]}],
      locations:[{id:'room',name:'Room',description:'Quiet studio',referenceAssetIds:[]}],
      styleRefs:[{id:'cinema',name:'Cinema',description:'Warm realistic light',referenceAssetIds:[]}],
    },
    scenes:[{
      clientRef:'scene-1',
      title:'The Last Light',
      shots:[5,5,6,6,6,6,6,5].map((durationSeconds,i)=>({
        clientRef:`shot-${i+1}`,
        spec:{
          schemaVersion:'2',
          shotType:i===0?'ESTABLISHING':'CHARACTER',
          durationSeconds,
          prompt:`Shot ${i+1}: the hero restores the lamp`,
          camera:{angle:'EYE_LEVEL',framing:'Medium',movement:'Static'},
          styleRefId:'cinema',
          subjectIds:['hero'],
          locationId:'room',
          continuity:{start:state,end:state},
        },
      })),
    }],
  }) as StoryContentV2;
}

/** Default production canonical story alias (v2). */
export function canonicalStory(): StoryContentV2 {
  return canonicalStoryV2();
}
