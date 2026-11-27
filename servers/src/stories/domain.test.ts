import { expect, it } from 'vitest';
import { canonicalStory, canonicalStoryV1, upgradeBibleToV2 } from '@nolen/contracts';
import { hash, policy, referenceErrors, RULESET, shotDependency, validate } from './domain.js';

it('canonical 45s/eight-shot story resolves references; REQUIRED without an asset is valid at G1',()=>{
  const content=canonicalStoryV1();
  expect(content.scenes[0].shots).toHaveLength(8);
  expect(referenceErrors(content)).toEqual([]);expect(validate(content,45)).toEqual([]);
  expect(policy(content.scenes[0].shots[0].spec,content)).toMatchObject({effectiveRequirement:'REQUIRED',ruleSetVersion:'story-approval-2'});
  expect(hash({b:1,a:2})).toBe(hash({a:2,b:1}));
});
it('identity changes invalidate referenced shot dependencies while unrelated definitions do not',()=>{
  const c=canonicalStoryV1(),spec=c.scenes[0].shots[0].spec;const original=shotDependency(spec,c);
  c.storyBible.characters.push({id:'unused',name:'Unused',description:'Unrelated'});
  expect(shotDependency(spec,c)).toBe(original);
  c.storyBible.characters[0].description='Changed identity';
  expect(shotDependency(spec,c)).not.toBe(original);
});
it('continuity errors are scoped, only wardrobe/held-prop waivable; explicit transitions have reasons',()=>{
  const c=canonicalStoryV1();const s=c.scenes[0].shots[1].spec;
  c.storyBible.wardrobes.push({id:'shirt',name:'Shirt',description:'White shirt'});
  s.continuity.start.characterStates[0].wardrobeId='shirt';s.continuity.start.lighting='Night';
  const f=validate(c,45);
  expect(f.some(x=>x.code==='WARDROBE_PROP'&&x.waivable)).toBe(true);
  expect(f.some(x=>x.code==='LOCATION_LIGHTING'&&!x.waivable)).toBe(true);
  s.intendedTransitions=[{field:'lighting',reason:'Intentional lighting cut'}];
  expect(validate(c,45).some(x=>x.code==='LOCATION_LIGHTING')).toBe(false);
});
it('invalid references fail structural validation; duration errors cannot be waived',()=>{
  const c=canonicalStoryV1();c.scenes[0].shots[0].spec.styleRefId='foreign';
  expect(referenceErrors(c).length).toBeGreaterThan(0);
  c.scenes[0].shots[0].spec.durationSeconds=60;
  expect(validate(c,45).find(f=>f.code==='DURATION_RANGE')?.waivable).toBe(false);
});

it('recurring-character style identity cannot be waived or bypassed by an OPTIONAL keyframe override',()=>{
  const c=canonicalStoryV1();c.storyBible.styleRefs.push({id:'different',name:'Different',description:'A different visual identity'});
  c.scenes[0].shots[1].spec.styleRefId='different';c.scenes[0].shots[1].spec.keyframeOverride={requirement:'OPTIONAL',reason:'Producer accepts keyframe risk',riskAcknowledged:true};
  expect(validate(c,45).some(f=>f.code==='IDENTITY_LOCK'&&!f.waivable)).toBe(true);
  const broll=structuredClone(c.scenes[0].shots[0].spec);broll.subjectIds=[];broll.continuity.start.characterStates=[];broll.continuity.end.characterStates=[];broll.continuity.start.propIds=[];broll.continuity.end.propIds=[];
  expect(policy(broll,c).effectiveRequirement).toBe('OPTIONAL');broll.shotType='OTHER';expect(policy(broll,c).riskFlags).toContain('UNKNOWN_RISK');
});

it('locks recurring identity after B-roll and across Scene boundaries, using subjectIds as appearance',()=>{
  const cutaway=canonicalStoryV1();cutaway.storyBible.styleRefs.push({id:'different',name:'Different',description:'A different visual identity'});
  const broll=cutaway.scenes[0].shots[1].spec;broll.shotType='BROLL';broll.subjectIds=[];broll.continuity.start.characterStates=[];broll.continuity.end.characterStates=[];
  for(const shot of cutaway.scenes[0].shots.slice(2))shot.spec.styleRefId='different';
  expect(validate(cutaway,45).some(f=>f.code==='IDENTITY_LOCK'&&f.path==='shots.2.styleRefId')).toBe(true);

  const crossScene=canonicalStoryV1();crossScene.storyBible.styleRefs.push({id:'different',name:'Different',description:'A different visual identity'});
  const bridge=crossScene.scenes[0].shots[1].spec;bridge.shotType='BROLL';bridge.subjectIds=[];bridge.continuity.start.characterStates=[];bridge.continuity.end.characterStates=[];
  const returning=crossScene.scenes[0].shots.splice(2);returning.forEach(shot=>{shot.spec.styleRefId='different';});
  crossScene.scenes.push({clientRef:'scene-2',title:'Return',shots:returning});
  expect(validate(crossScene,45).some(f=>f.code==='IDENTITY_LOCK'&&f.path==='shots.2.styleRefId')).toBe(true);

  const contextOnly=canonicalStoryV1();contextOnly.storyBible.styleRefs.push({id:'different',name:'Different',description:'A different visual identity'});
  contextOnly.scenes[0].shots[1].spec.subjectIds=[];contextOnly.scenes[0].shots[1].spec.styleRefId='different';
  expect(validate(contextOnly,45).some(f=>f.code==='IDENTITY_LOCK')).toBe(false);
});

it('rejects contradictory locations inside a Shot regardless of transitions',()=>{
  const c=canonicalStoryV1();c.storyBible.locations.push({id:'street',name:'Street',description:'Outdoor street'});
  const shot=c.scenes[0].shots[0].spec;shot.locationId='street';shot.intendedTransitions=[{field:'location',reason:'Intentional cut'}];
  const errors=referenceErrors(c);
  expect(errors).toContain('shots.0.start.locationId: must match shots.0.locationId');
  expect(errors).toContain('shots.0.end.locationId: must match shots.0.locationId');
  expect(validate(c,45).some(f=>f.code==='SCHEMA_VALID')).toBe(true);
});

it('only applies an untargeted transition to one mismatch of the same field',()=>{
  const story=()=>{
    const c=canonicalStoryV1();c.scenes[0].shots=c.scenes[0].shots.slice(0,2);c.scenes[0].shots[0].spec.durationSeconds=20;c.scenes[0].shots[1].spec.durationSeconds=25;
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

it('normalizes empty referenceAssetIds identically to v1 and scopes dependency changes to bound shots', () => {
  expect(RULESET).toBe('story-approval-2');
  const v1 = canonicalStoryV1();
  const shot0V1 = v1.scenes[0].shots[0].spec;
  const origHash = shotDependency(shot0V1, v1);

  // Add an unused location and upgrade Bible to v2 with empty referenceAssetIds
  const upgradedEmpty = {
    ...v1,
    storyBible: upgradeBibleToV2(v1.storyBible),
  };
  expect(shotDependency(shot0V1, upgradedEmpty)).toBe(origHash);

  // Now bind a reference asset to an unused location -> shot0 hash MUST stay identical
  const unusedLocId = 'unused-loc';
  const refAssetId = '22222222-2222-4222-8222-222222222222';
  const withUnusedBound = structuredClone(upgradedEmpty);
  withUnusedBound.storyBible.locations.push({
    id: unusedLocId,
    name: 'Unused',
    description: 'Never referenced by shot 0',
    referenceAssetIds: [refAssetId],
  });
  expect(shotDependency(shot0V1, withUnusedBound)).toBe(origHash);

  // Now bind a reference asset to 'room' (referenced by shot0) -> hash MUST change, and order-independent
  const refA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const refB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const boundAB = structuredClone(upgradedEmpty);
  boundAB.storyBible.locations[0].referenceAssetIds = [refA, refB];
  const boundBA = structuredClone(upgradedEmpty);
  boundBA.storyBible.locations[0].referenceAssetIds = [refB, refA, refA];
  expect(shotDependency(shot0V1, boundAB)).not.toBe(origHash);
  expect(shotDependency(shot0V1, boundAB)).toBe(shotDependency(shot0V1, boundBA));
});

it('offline fixture: exact end->start string mismatch in pose and lighting triggers ERRORs unless matched or declared in intendedTransitions', () => {
  const makeTwoShotFixture = () => {
    const c = canonicalStoryV1();
    c.scenes[0].shots = c.scenes[0].shots.slice(0, 2);
    c.scenes[0].shots[0].spec.durationSeconds = 20;
    c.scenes[0].shots[1].spec.durationSeconds = 25;
    c.scenes[0].shots[0].spec.continuity.end.lighting = 'Warm daylight';
    c.scenes[0].shots[0].spec.continuity.end.characterStates[0].pose = 'Sitting at desk';
    c.scenes[0].shots[1].spec.continuity.start.lighting = 'Warm daylight';
    c.scenes[0].shots[1].spec.continuity.start.characterStates[0].pose = 'Sitting at desk';
    c.scenes[0].shots[1].spec.intendedTransitions = [];
    return c;
  };

  // (2) Matching end->start produces 0 continuity ERRORs (even when shot 0 changes internally from start to end)
  const matched = makeTwoShotFixture();
  expect(validate(matched, 45).filter((f) => f.severity === 'ERROR')).toEqual([]);

  // (1) Case-only mismatch in pose and lighting when intendedTransitions is empty
  const caseMismatched = makeTwoShotFixture();
  caseMismatched.scenes[0].shots[1].spec.continuity.start.characterStates[0].pose = 'sitting at desk';
  caseMismatched.scenes[0].shots[1].spec.continuity.start.lighting = 'Warm Daylight';
  const findings = validate(caseMismatched, 45);
  expect(findings).toContainEqual(
    expect.objectContaining({
      code: 'TEMPORAL_STATE',
      severity: 'ERROR',
      waivable: false,
      path: 'shots.1.continuity.pose.hero',
    }),
  );
  expect(findings).toContainEqual(
    expect.objectContaining({
      code: 'LOCATION_LIGHTING',
      severity: 'ERROR',
      waivable: false,
      path: 'shots.1.continuity.lighting',
    }),
  );

  // (3) Actual intentional pose and lighting change with matching intendedTransitions clears both ERRORs
  const intentionalChange = makeTwoShotFixture();
  intentionalChange.scenes[0].shots[1].spec.continuity.start.characterStates[0].pose = 'Standing by desk';
  intentionalChange.scenes[0].shots[1].spec.continuity.start.lighting = 'Cool dusk';
  intentionalChange.scenes[0].shots[1].spec.intendedTransitions = [
    { field: 'pose', reason: 'Character stands up across cut' },
    { field: 'lighting', reason: 'Time-of-day shift' },
  ];
  expect(validate(intentionalChange, 45).filter((f) => f.severity === 'ERROR')).toEqual([]);
});

it('offline fixture: recurring character changing styleRefId triggers IDENTITY_LOCK ERROR', () => {
  const c = canonicalStoryV1();
  c.scenes[0].shots = c.scenes[0].shots.slice(0, 2);
  c.scenes[0].shots[0].spec.durationSeconds = 20;
  c.scenes[0].shots[1].spec.durationSeconds = 25;
  c.storyBible.styleRefs.push({
    id: 'noir-sketch',
    name: 'Noir Sketch',
    description: 'High-contrast ink sketch',
  });
  c.scenes[0].shots[1].spec.styleRefId = 'noir-sketch';

  const findings = validate(c, 45);
  expect(findings).toContainEqual(
    expect.objectContaining({
      code: 'IDENTITY_LOCK',
      severity: 'ERROR',
      waivable: false,
      path: 'shots.1.styleRefId',
    }),
  );
});
