import { expect, it } from 'vitest';
import { canonicalStory } from '@nolen/contracts';
import { hash, policy, referenceErrors, shotDependency, validate } from './domain.js';

it('canonical 45s/eight-shot story resolves references; REQUIRED without an asset is valid at G1',()=>{
  const content=canonicalStory();
  expect(content.scenes[0].shots).toHaveLength(8);
  expect(referenceErrors(content)).toEqual([]);expect(validate(content,45)).toEqual([]);
  expect(policy(content.scenes[0].shots[0].spec,content)).toMatchObject({effectiveRequirement:'REQUIRED',ruleSetVersion:'story-approval-2'});
  expect(hash({b:1,a:2})).toBe(hash({a:2,b:1}));
});
it('identity changes invalidate referenced shot dependencies while unrelated definitions do not',()=>{
  const c=canonicalStory(),spec=c.scenes[0].shots[0].spec;const original=shotDependency(spec,c);
  c.storyBible.characters.push({id:'unused',name:'Unused',description:'Unrelated'});
  expect(shotDependency(spec,c)).toBe(original);
  c.storyBible.characters[0].description='Changed identity';
  expect(shotDependency(spec,c)).not.toBe(original);
});
it('continuity errors are scoped, only wardrobe/held-prop waivable; explicit transitions have reasons',()=>{
  const c=canonicalStory();const s=c.scenes[0].shots[1].spec;
  c.storyBible.wardrobes.push({id:'shirt',name:'Shirt',description:'White shirt'});
  s.continuity.start.characterStates[0].wardrobeId='shirt';s.continuity.start.lighting='Night';
  const f=validate(c,45);
  expect(f.some(x=>x.code==='WARDROBE_PROP'&&x.waivable)).toBe(true);
  expect(f.some(x=>x.code==='LOCATION_LIGHTING'&&!x.waivable)).toBe(true);
  s.intendedTransitions=[{field:'lighting',reason:'Intentional lighting cut'}];
  expect(validate(c,45).some(x=>x.code==='LOCATION_LIGHTING')).toBe(false);
});
it('invalid references fail structural validation; duration errors cannot be waived',()=>{
  const c=canonicalStory();c.scenes[0].shots[0].spec.styleRefId='foreign';
  expect(referenceErrors(c).length).toBeGreaterThan(0);
  c.scenes[0].shots[0].spec.durationSeconds=60;
  expect(validate(c,45).find(f=>f.code==='DURATION_RANGE')?.waivable).toBe(false);
});

it('recurring-character style identity cannot be waived or bypassed by an OPTIONAL keyframe override',()=>{
  const c=canonicalStory();c.storyBible.styleRefs.push({id:'different',name:'Different',description:'A different visual identity'});
  c.scenes[0].shots[1].spec.styleRefId='different';c.scenes[0].shots[1].spec.keyframeOverride={requirement:'OPTIONAL',reason:'Producer accepts keyframe risk',riskAcknowledged:true};
  expect(validate(c,45).some(f=>f.code==='IDENTITY_LOCK'&&!f.waivable)).toBe(true);
  const broll=structuredClone(c.scenes[0].shots[0].spec);broll.subjectIds=[];broll.continuity.start.characterStates=[];broll.continuity.end.characterStates=[];broll.continuity.start.propIds=[];broll.continuity.end.propIds=[];
  expect(policy(broll,c).effectiveRequirement).toBe('OPTIONAL');broll.shotType='OTHER';expect(policy(broll,c).riskFlags).toContain('UNKNOWN_RISK');
});

it('locks recurring identity after B-roll and across Scene boundaries, using subjectIds as appearance',()=>{
  const cutaway=canonicalStory();cutaway.storyBible.styleRefs.push({id:'different',name:'Different',description:'A different visual identity'});
  const broll=cutaway.scenes[0].shots[1].spec;broll.shotType='BROLL';broll.subjectIds=[];broll.continuity.start.characterStates=[];broll.continuity.end.characterStates=[];
  for(const shot of cutaway.scenes[0].shots.slice(2))shot.spec.styleRefId='different';
  expect(validate(cutaway,45).some(f=>f.code==='IDENTITY_LOCK'&&f.path==='shots.2.styleRefId')).toBe(true);

  const crossScene=canonicalStory();crossScene.storyBible.styleRefs.push({id:'different',name:'Different',description:'A different visual identity'});
  const bridge=crossScene.scenes[0].shots[1].spec;bridge.shotType='BROLL';bridge.subjectIds=[];bridge.continuity.start.characterStates=[];bridge.continuity.end.characterStates=[];
  const returning=crossScene.scenes[0].shots.splice(2);returning.forEach(shot=>{shot.spec.styleRefId='different';});
  crossScene.scenes.push({clientRef:'scene-2',title:'Return',shots:returning});
  expect(validate(crossScene,45).some(f=>f.code==='IDENTITY_LOCK'&&f.path==='shots.2.styleRefId')).toBe(true);

  const contextOnly=canonicalStory();contextOnly.storyBible.styleRefs.push({id:'different',name:'Different',description:'A different visual identity'});
  contextOnly.scenes[0].shots[1].spec.subjectIds=[];contextOnly.scenes[0].shots[1].spec.styleRefId='different';
  expect(validate(contextOnly,45).some(f=>f.code==='IDENTITY_LOCK')).toBe(false);
});

it('rejects contradictory locations inside a Shot regardless of transitions',()=>{
  const c=canonicalStory();c.storyBible.locations.push({id:'street',name:'Street',description:'Outdoor street'});
  const shot=c.scenes[0].shots[0].spec;shot.locationId='street';shot.intendedTransitions=[{field:'location',reason:'Intentional cut'}];
  const errors=referenceErrors(c);
  expect(errors).toContain('shots.0.start.locationId: must match shots.0.locationId');
  expect(errors).toContain('shots.0.end.locationId: must match shots.0.locationId');
  expect(validate(c,45).some(f=>f.code==='SCHEMA_VALID')).toBe(true);
});

it('only applies an untargeted transition to one mismatch of the same field',()=>{
  const story=()=>{
    const c=canonicalStory();c.scenes[0].shots=c.scenes[0].shots.slice(0,2);c.scenes[0].shots[0].spec.durationSeconds=20;c.scenes[0].shots[1].spec.durationSeconds=25;
    c.storyBible.characters.push({id:'friend',name:'Friend',description:'Second recurring adult'});
    c.storyBible.wardrobes.push({id:'blue',name:'Blue',description:'Blue shirt'},{id:'green',name:'Green',description:'Green shirt'});
    const first=c.scenes[0].shots[0].spec,second=c.scenes[0].shots[1].spec;
    first.subjectIds=['hero','friend'];second.subjectIds=['hero','friend'];
    first.continuity.start.characterStates=[{characterId:'hero',wardrobeId:'coat',pose:'Standing',heldPropIds:[]},{characterId:'friend',wardrobeId:'blue',pose:'Standing',heldPropIds:[]}];
    first.continuity.end.characterStates=structuredClone(first.continuity.start.characterStates);
    second.continuity.start.characterStates=[{characterId:'hero',wardrobeId:'blue',pose:'Standing',heldPropIds:[]},{characterId:'friend',wardrobeId:'green',pose:'Standing',heldPropIds:[]}];
    second.continuity.end.characterStates=structuredClone(second.continuity.start.characterStates);
    second.intendedTransitions=[{field:'wardrobe',reason:'An intentional wardrobe change'}];return c;
  };
  const ambiguous=validate(story(),45).filter(f=>f.code==='WARDROBE_PROP'&&f.path.startsWith('shots.1'));
  expect(ambiguous).toHaveLength(2);
  const single=story();single.scenes[0].shots[1].spec.continuity.start.characterStates[0].wardrobeId='coat';
  expect(validate(single,45).filter(f=>f.code==='WARDROBE_PROP'&&f.path.startsWith('shots.1'))).toHaveLength(0);
});
