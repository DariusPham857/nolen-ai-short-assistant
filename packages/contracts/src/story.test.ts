import { expect, it } from 'vitest';
import {
  canonicalStory,
  canonicalStoryV1,
  canonicalStoryV2,
  createShotSpecV2,
  saveStorySchema,
  planProposalRequestSchema,
  storyProposalV2Schema,
  proposalToStoryContentV2,
  storyContentSchema,
  upgradeBibleToV2,
  validateStorySchema,
} from './story.js';

it('accepts canonical input and rejects duplicate IDs, bounds, unsafe derived fields',()=>{
  const c=canonicalStory();expect(storyContentSchema.safeParse(c).success).toBe(true);
  c.scenes[0].shots[1].clientRef=c.scenes[0].shots[0].clientRef;
  expect(storyContentSchema.safeParse(c).success).toBe(false);
  expect(saveStorySchema.safeParse({expectedStoryRevisionId:null,expectedStateVersion:0,content:canonicalStory(),approved:true}).success).toBe(false);
  expect(validateStorySchema.parse({expectedStoryRevisionId:null,expectedStateVersion:0}).context).toBe('STORY_APPROVAL');
});

it('preserves exact v1 historical parse without injecting v2 fields and validates v2 angle/bible', () => {
  const v1 = canonicalStoryV1();
  const parsedV1 = storyContentSchema.parse(v1);
  expect(parsedV1.storyBible.schemaVersion).toBe('1');
  expect('referenceAssetIds' in parsedV1.storyBible.characters[0]).toBe(false);
  expect(parsedV1.scenes[0].shots[0].spec.schemaVersion).toBe('1');
  expect('angle' in parsedV1.scenes[0].shots[0].spec.camera).toBe(false);

  const v2 = canonicalStoryV2();
  expect(v2.storyBible.schemaVersion).toBe('2');
  expect(v2.scenes[0].shots[0].spec.schemaVersion).toBe('2');
  if (v2.scenes[0].shots[0].spec.schemaVersion === '2') {
    expect(v2.scenes[0].shots[0].spec.camera.angle).toBe('EYE_LEVEL');
  }

  // Reject invalid camera angle in v2
  const badAngle = structuredClone(v2);
  (badAngle.scenes[0].shots[0].spec.camera as unknown as { angle: string }).angle = 'BAD_ANGLE';
  expect(storyContentSchema.safeParse(badAngle).success).toBe(false);

  // Mixed v1 + v2 revision (upgraded Bible v2 + v1 shot + v2 shot)
  const assetId = '11111111-1111-4111-8111-111111111111';
  const upgradedBible = upgradeBibleToV2(v1.storyBible, { group: 'characters', id: 'hero', assetId });
  expect(upgradedBible.schemaVersion).toBe('2');
  expect(upgradedBible.characters[0].referenceAssetIds).toEqual([assetId]);
  expect(upgradedBible.locations[0].referenceAssetIds).toEqual([]);

  const mixed = {
    script: v1.script,
    storyBible: upgradedBible,
    scenes: [{
      clientRef: 'scene-1',
      title: 'Scene 1',
      shots: [
        v1.scenes[0].shots[0],
        {
          clientRef: 'shot-2',
          spec: createShotSpecV2({
            shotType: 'CHARACTER',
            durationSeconds: 5,
            prompt: 'Hero looks closely at the lamp',
            camera: { angle: 'LOW_ANGLE', framing: 'Close-up', movement: 'Static' },
            styleRefId: 'cinema',
            subjectIds: ['hero'],
            locationId: 'room',
            continuity: v1.scenes[0].shots[1].spec.continuity,
          }),
        },
      ],
    }],
  };
  const parsedMixed = storyContentSchema.parse(mixed);
  expect(parsedMixed.storyBible.schemaVersion).toBe('2');
  expect(parsedMixed.scenes[0].shots[0].spec.schemaVersion).toBe('1');
  expect(parsedMixed.scenes[0].shots[1].spec.schemaVersion).toBe('2');
});

it('validates planProposalRequestSchema defaults and strict storyProposalV2Schema boundaries (FP-AT-01)', () => {
  expect(planProposalRequestSchema.parse({ expectedStoryRevisionId: null, expectedStateVersion: 0 }).mode).toBe('FIXTURE');
  expect(planProposalRequestSchema.parse({ expectedStoryRevisionId: null, expectedStateVersion: 0, mode: 'GEMINI_FREE_PLANNER' }).mode).toBe('GEMINI_FREE_PLANNER');
  expect(planProposalRequestSchema.safeParse({ expectedStoryRevisionId: null, expectedStateVersion: 0, extra: true }).success).toBe(false);

  const validProposal = {
    script: 'A short film about a desk lamp.',
    storyBible: {
      schemaVersion: '2',
      narrative: 'Warm realism',
      characters: [{ id: 'hero', name: 'Hero', description: 'Adult' }],
      wardrobes: [{ id: 'coat', name: 'Coat', description: 'Brown coat' }],
      props: [{ id: 'lamp', name: 'Lamp', description: 'Desk lamp', hero: true }],
      locations: [{ id: 'room', name: 'Room', description: 'Quiet room' }],
      styleRefs: [{ id: 'cinema', name: 'Cinema', description: 'Warm light' }],
    },
    scenes: [{
      clientRef: 'scene-1',
      title: 'Scene 1',
      shots: [{
        clientRef: 'shot-1',
        spec: {
          schemaVersion: '2',
          shotType: 'ESTABLISHING',
          durationSeconds: 30,
          prompt: 'Wide shot of the room',
          negativePrompt: '',
          styleRefId: 'cinema',
          subjectIds: ['hero'],
          locationId: 'room',
          continuity: {
            start: { locationId: 'room', lighting: 'Warm', propIds: ['lamp'], characterStates: [{ characterId: 'hero', wardrobeId: 'coat', pose: 'Standing', heldPropIds: [] }] },
            end: { locationId: 'room', lighting: 'Warm', propIds: ['lamp'], characterStates: [{ characterId: 'hero', wardrobeId: 'coat', pose: 'Standing', heldPropIds: [] }] },
          },
          intendedTransitions: [],
          camera: { angle: 'EYE_LEVEL', framing: 'Wide', movement: 'Static' },
        },
      }],
    }],
  };

  const parsed = storyProposalV2Schema.parse(validProposal);
  const converted = proposalToStoryContentV2(parsed);
  expect(converted.storyBible.characters[0].referenceAssetIds).toEqual([]);
  expect(converted.scenes[0].shots[0].spec.keyframeOverride).toBeNull();

  // Reject v1 shape
  const v1Shape = structuredClone(validProposal);
  (v1Shape.storyBible as { schemaVersion: string }).schemaVersion = '1';
  expect(storyProposalV2Schema.safeParse(v1Shape).success).toBe(false);

  // Reject entity UUIDs, expectedShotRevisionId, referenceAssetIds, keyframeOverride
  const withSceneId = structuredClone(validProposal);
  (withSceneId.scenes[0] as Record<string, unknown>).id = '11111111-1111-4111-8111-111111111111';
  expect(storyProposalV2Schema.safeParse(withSceneId).success).toBe(false);

  const withShotId = structuredClone(validProposal);
  (withShotId.scenes[0].shots[0] as Record<string, unknown>).id = '11111111-1111-4111-8111-111111111111';
  expect(storyProposalV2Schema.safeParse(withShotId).success).toBe(false);

  const withExpectedShotRev = structuredClone(validProposal);
  (withExpectedShotRev.scenes[0].shots[0] as Record<string, unknown>).expectedShotRevisionId = '11111111-1111-4111-8111-111111111111';
  expect(storyProposalV2Schema.safeParse(withExpectedShotRev).success).toBe(false);

  const withRefAssets = structuredClone(validProposal);
  (withRefAssets.storyBible.characters[0] as Record<string, unknown>).referenceAssetIds = ['11111111-1111-4111-8111-111111111111'];
  expect(storyProposalV2Schema.safeParse(withRefAssets).success).toBe(false);

  const withOverride = structuredClone(validProposal);
  (withOverride.scenes[0].shots[0].spec as Record<string, unknown>).keyframeOverride = { requirement: 'OPTIONAL', reason: 'bypass', riskAcknowledged: true };
  expect(storyProposalV2Schema.safeParse(withOverride).success).toBe(false);
});
