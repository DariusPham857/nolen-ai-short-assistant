import { createHash } from 'node:crypto';
import type { StoryContent, ShotSpec, Policy, Finding } from '@nolen/contracts';

export const RULESET = 'story-approval-2';
/** Sorted object keys make hashes independent of JSON property insertion order. Arrays retain story order. */
export function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value!==null && typeof value==='object')return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
/** Hash normalized inputs; never hash raw HTTP bytes. */
export function hash(value:unknown):string{return createHash('sha256').update(canonical(value)).digest('hex');}

/** Missing Bible references are structural errors, not waivable continuity findings. */
export function referenceErrors(content:StoryContent):string[] {
  const b=content.storyBible;const errors:string[]=[];
  const check=(group: 'characters'|'wardrobes'|'props'|'locations'|'styleRefs',id:string,path:string)=>{
    if(!b[group].some(x=>x.id===id))errors.push(`${path}: unknown ${group}/${id}`);
  };
  for(const [i,shot] of content.scenes.flatMap(s=>s.shots).entries()){
    const s=shot.spec;check('locations',s.locationId,`shots.${i}.locationId`);check('styleRefs',s.styleRefId,`shots.${i}.styleRefId`);
    s.subjectIds.forEach(id=>check('characters',id,`shots.${i}.subjectIds`));
    for(const side of ['start','end'] as const){
      const v=s.continuity[side];check('locations',v.locationId,`shots.${i}.${side}`);
      if(v.locationId!==s.locationId)errors.push(`shots.${i}.${side}.locationId: must match shots.${i}.locationId`);
      v.propIds.forEach(id=>check('props',id,`shots.${i}.${side}.propIds`));
      if(new Set(v.characterStates.map(c=>c.characterId)).size!==v.characterStates.length)errors.push(`shots.${i}.${side}: duplicate character`);
      for(const c of v.characterStates){check('characters',c.characterId,`shots.${i}.${side}`);check('wardrobes',c.wardrobeId,`shots.${i}.${side}`);c.heldPropIds.forEach(id=>check('props',id,`shots.${i}.${side}`));}
      if(s.subjectIds.some(id=>!v.characterStates.some(c=>c.characterId===id)))errors.push(`shots.${i}.${side}: missing subject state`);
    }
  }
  return errors;
}

/** Explainable G1 classification; no asset or provider eligibility is checked here. */
export function policy(spec:ShotSpec,content:StoryContent):Policy {
  const states=[spec.continuity.start,spec.continuity.end];
  const flags:string[]=[];
  if(spec.subjectIds.length || states.some(s=>s.characterStates.length))flags.push('CHARACTER_IDENTITY');
  if(states.some(s=>s.propIds.length || s.characterStates.some(c=>c.heldPropIds.length)))flags.push('PROP_CONTINUITY');
  if(content.storyBible.props.some(p=>p.hero && states.some(s=>s.propIds.includes(p.id))))flags.push('HERO_BRANDING');
  if(!['ESTABLISHING','BROLL','INSERT'].includes(spec.shotType) && !flags.length)flags.push('UNKNOWN_RISK');
  const recommendation=flags.length?'REQUIRED':'OPTIONAL';
  return {systemRecommendation:recommendation,effectiveRequirement:spec.keyframeOverride?.requirement??recommendation,riskFlags:flags,ruleSetVersion:RULESET};
}

/** Normalize Bible definition for dependency hashing: omit empty referenceAssetIds so v1 hashes match v2 empty bindings. */
function normalizeBindingDef(def: { id: string; name: string; description: string; hero?: boolean; referenceAssetIds?: string[] }) {
  if (!def.referenceAssetIds || def.referenceAssetIds.length === 0) {
    const rest = { ...def };
    delete rest.referenceAssetIds;
    return rest;
  }
  return { ...def, referenceAssetIds: [...new Set(def.referenceAssetIds)].sort() };
}

/** Resolve only referenced definitions so unrelated Bible edits can reuse unaffected ShotRevisions. */
export function shotDependency(spec:ShotSpec,content:StoryContent):string {
  const states=[spec.continuity.start,spec.continuity.end];
  const characterIds=new Set([...spec.subjectIds,...states.flatMap(s=>s.characterStates.map(c=>c.characterId))]);
  const wardrobeIds=new Set(states.flatMap(s=>s.characterStates.map(c=>c.wardrobeId)));
  const propIds=new Set(states.flatMap(s=>[...s.propIds,...s.characterStates.flatMap(c=>c.heldPropIds)]));
  const locationIds=new Set([spec.locationId,...states.map(s=>s.locationId)]);const b=content.storyBible;
  return hash({
    spec,
    bindings:{
      characters:b.characters.filter(x=>characterIds.has(x.id)).map(x=>normalizeBindingDef(x)),
      wardrobes:b.wardrobes.filter(x=>wardrobeIds.has(x.id)).map(x=>normalizeBindingDef(x)),
      props:b.props.filter(x=>propIds.has(x.id)).map(x=>normalizeBindingDef(x)),
      locations:b.locations.filter(x=>locationIds.has(x.id)).map(x=>normalizeBindingDef(x)),
      styleRefs:b.styleRefs.filter(x=>x.id===spec.styleRefId).map(x=>normalizeBindingDef(x)),
    },
    policy:policy(spec,content),
  });
}

/** Deterministic STORY_APPROVAL checks across every adjacent shot, including scene boundaries. */
export function validate(content:StoryContent,target:number):Finding[] {
  const findings:Finding[]=[];const shots=content.scenes.flatMap(s=>s.shots);
  const add=(code:string,path:string,message:string,waivable=false,severity:'ERROR'|'WARNING'='ERROR')=>findings.push({fingerprint:hash({code,path,message}),code,path,message,waivable,severity});
  referenceErrors(content).forEach(message=>add('SCHEMA_VALID','storyBible',message));
  const duration=shots.reduce((sum,s)=>sum+s.spec.durationSeconds,0);
  if(duration<30 || duration>60)add('DURATION_RANGE','duration',`Total ${duration}s must be 30–60s`);
  else if(duration!==target)add('TARGET_DURATION','duration',`Total ${duration}s differs from target ${target}s`,false,'WARNING');
  const lockedStyles=new Map<string,string>();
  for(const [i,shot] of shots.entries()){
    for(const characterId of shot.spec.subjectIds){
      const locked=lockedStyles.get(characterId);
      if(locked===undefined)lockedStyles.set(characterId,shot.spec.styleRefId);
      else if(locked!==shot.spec.styleRefId)add('IDENTITY_LOCK',`shots.${i}.styleRefId`,'A recurring character must retain the locked visual identity style');
    }
  }
  for(let i=1;i<shots.length;i++){
    const previous=shots[i-1].spec.continuity.end;const next=shots[i].spec.continuity.start;
    const transitions=shots[i].spec.intendedTransitions;
    type EdgeMismatch={field:'wardrobe'|'heldProps'|'pose'|'location'|'lighting'|'props';a:unknown;b:unknown;waivable:boolean;suffix:string};
    const candidates:EdgeMismatch[]=[
      {field:'location',a:previous.locationId,b:next.locationId,waivable:false,suffix:''},
      {field:'lighting',a:previous.lighting,b:next.lighting,waivable:false,suffix:''},
      {field:'props',a:[...previous.propIds].sort(),b:[...next.propIds].sort(),waivable:false,suffix:''},
    ];
    for(const before of previous.characterStates){
      const after=next.characterStates.find(c=>c.characterId===before.characterId);if(!after)continue;
      candidates.push(
        {field:'wardrobe',a:before.wardrobeId,b:after.wardrobeId,waivable:true,suffix:`.${before.characterId}`},
        {field:'heldProps',a:[...before.heldPropIds].sort(),b:[...after.heldPropIds].sort(),waivable:true,suffix:`.${before.characterId}`},
        {field:'pose',a:before.pose,b:after.pose,waivable:false,suffix:`.${before.characterId}`},
      );
    }
    const mismatches=candidates.filter(x=>canonical(x.a)!==canonical(x.b));
    for(const mismatch of mismatches){
      const unambiguous=mismatches.filter(x=>x.field===mismatch.field).length===1;
      if(unambiguous && transitions.some(t=>t.field===mismatch.field))continue;
      const code=mismatch.field==='wardrobe'||mismatch.field==='heldProps'?'WARDROBE_PROP':mismatch.field==='pose'?'TEMPORAL_STATE':'LOCATION_LIGHTING';
      add(code,`shots.${i}.continuity.${mismatch.field}${mismatch.suffix}`,`${mismatch.field} differs across shot ${i} → ${i+1}${mismatch.suffix}`,mismatch.waivable);
    }
  }
  return findings;
}
