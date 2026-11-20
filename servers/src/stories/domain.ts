import { createHash } from 'node:crypto';
import type { StoryContent, ShotSpec, Policy, Finding } from '@nolen/contracts';

export const RULESET = 'story-approval-1';
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

/** Resolve only referenced definitions so unrelated Bible edits can reuse unaffected ShotRevisions. */
export function shotDependency(spec:ShotSpec,content:StoryContent):string {
  const states=[spec.continuity.start,spec.continuity.end];
  const characterIds=new Set([...spec.subjectIds,...states.flatMap(s=>s.characterStates.map(c=>c.characterId))]);
  const wardrobeIds=new Set(states.flatMap(s=>s.characterStates.map(c=>c.wardrobeId)));
  const propIds=new Set(states.flatMap(s=>[...s.propIds,...s.characterStates.flatMap(c=>c.heldPropIds)]));
  const locationIds=new Set([spec.locationId,...states.map(s=>s.locationId)]);const b=content.storyBible;
  return hash({spec,bindings:{characters:b.characters.filter(x=>characterIds.has(x.id)),wardrobes:b.wardrobes.filter(x=>wardrobeIds.has(x.id)),props:b.props.filter(x=>propIds.has(x.id)),locations:b.locations.filter(x=>locationIds.has(x.id)),styleRefs:b.styleRefs.filter(x=>x.id===spec.styleRefId)},policy:policy(spec,content)});
}

/** Deterministic STORY_APPROVAL checks across every adjacent shot, including scene boundaries. */
export function validate(content:StoryContent,target:number):Finding[] {
  const findings:Finding[]=[];const shots=content.scenes.flatMap(s=>s.shots);
  const add=(code:string,path:string,message:string,waivable=false,severity:'ERROR'|'WARNING'='ERROR')=>findings.push({fingerprint:hash({code,path,message}),code,path,message,waivable,severity});
  referenceErrors(content).forEach(message=>add('SCHEMA_VALID','storyBible',message));
  const duration=shots.reduce((sum,s)=>sum+s.spec.durationSeconds,0);
  if(duration<30 || duration>60)add('DURATION_RANGE','duration',`Total ${duration}s must be 30–60s`);
  else if(duration!==target)add('TARGET_DURATION','duration',`Total ${duration}s differs from target ${target}s`,false,'WARNING');
  for(let i=1;i<shots.length;i++){
    const previous=shots[i-1].spec.continuity.end;const next=shots[i].spec.continuity.start;
    if(shots[i-1].spec.styleRefId!==shots[i].spec.styleRefId && previous.characterStates.some(c=>next.characterStates.some(n=>n.characterId===c.characterId)))add('IDENTITY_LOCK',`shots.${i}.styleRefId`,'A recurring character must retain the locked visual identity style');
    const transitions=shots[i].spec.intendedTransitions;
    const compare=(field:'wardrobe'|'heldProps'|'pose'|'location'|'lighting'|'props',a:unknown,b:unknown,waivable=false,suffix='')=>{
      if(canonical(a)!==canonical(b) && !transitions.some(t=>t.field===field))add(field==='wardrobe'||field==='heldProps'?'WARDROBE_PROP':field==='pose'?'TEMPORAL_STATE':'LOCATION_LIGHTING',`shots.${i}.continuity.${field}${suffix}`,`${field} differs across shot ${i} → ${i+1}${suffix}`,waivable);
    };
    compare('location',previous.locationId,next.locationId);compare('lighting',previous.lighting,next.lighting);compare('props',[...previous.propIds].sort(),[...next.propIds].sort());
    for(const before of previous.characterStates){
      const after=next.characterStates.find(c=>c.characterId===before.characterId);if(!after)continue;
      compare('wardrobe',before.wardrobeId,after.wardrobeId,true,`.${before.characterId}`);
      compare('heldProps',[...before.heldPropIds].sort(),[...after.heldPropIds].sort(),true,`.${before.characterId}`);
      compare('pose',before.pose,after.pose,false,`.${before.characterId}`);
    }
  }
  return findings;
}
