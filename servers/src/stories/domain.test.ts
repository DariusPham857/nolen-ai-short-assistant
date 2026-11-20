import { expect, it } from 'vitest';
import { canonicalStory } from '@nolen/contracts';
import { hash, policy, referenceErrors, shotDependency, validate } from './domain.js';

it('canonical 45s/eight-shot story resolves references; REQUIRED without an asset is valid at G1',()=>{
  const content=canonicalStory();
  expect(content.scenes[0].shots).toHaveLength(8);
  expect(referenceErrors(content)).toEqual([]);expect(validate(content,45)).toEqual([]);
  expect(policy(content.scenes[0].shots[0].spec,content).effectiveRequirement).toBe('REQUIRED');
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
