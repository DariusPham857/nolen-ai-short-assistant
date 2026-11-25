import { describe, expect, it } from 'vitest';
import { canonicalStoryV1, canonicalStoryV2, upgradeBibleToV2 } from '@nolen/contracts';
import { compileGenerationTemplate } from './compiler.js';

describe('compileGenerationTemplate (GI-03)', () => {
  const filmId = '11111111-1111-4111-8111-111111111111';
  const storyRevisionId = '22222222-2222-4222-8222-222222222222';
  const shotRevisionId = '33333333-3333-4333-8333-333333333333';
  const rateCardSnapshotId = '44444444-4444-4444-8444-444444444444';

  it('compiles deterministic IMAGE prompt with referenced entities only, separate negativePrompt, and sorted deduped assets', () => {
    const story = canonicalStoryV2();
    const charRefId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const locRefId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const unusedRefId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    story.storyBible.characters[0].referenceAssetIds = [charRefId];
    story.storyBible.locations[0].referenceAssetIds = [locRefId];
    story.storyBible.styleRefs[0].referenceAssetIds = [charRefId]; // same asset across multiple roles is kept
    story.storyBible.locations.push({
      id: 'unused_beach',
      name: 'Unused Beach',
      description: 'MUST_NOT_APPEAR_IN_PROMPT',
      referenceAssetIds: [unusedRefId],
    });
    story.scenes[0].shots[0].spec.negativePrompt = 'extra fingers, watermark';

    const refMap = new Map([
      [charRefId, { id: charRefId, sha256Hash: '1'.repeat(64), mimeType: 'image/png' }],
      [locRefId, { id: locRefId, sha256Hash: '2'.repeat(64), mimeType: 'image/jpeg' }],
      [unusedRefId, { id: unusedRefId, sha256Hash: '3'.repeat(64), mimeType: 'image/webp' }],
    ]);

    const t1 = compileGenerationTemplate({
      filmId,
      storyRevisionId,
      shotRevisionId,
      shotDependencyHash: 'd'.repeat(64),
      kind: 'IMAGE',
      shotSpec: story.scenes[0].shots[0].spec,
      storyBible: story.storyBible,
      referenceAssets: refMap,
      provider: 'GEMINI',
      modelId: 'gemini-3.1-flash-image',
      rateCardSnapshotId,
      executionMode: 'REPLAY',
      fixturePackVersion: 'v1',
      fixtureId: 'default-gemini-image-9-16',
    });

    const t2 = compileGenerationTemplate({
      filmId,
      storyRevisionId,
      shotRevisionId,
      shotDependencyHash: 'd'.repeat(64),
      kind: 'IMAGE',
      shotSpec: story.scenes[0].shots[0].spec,
      storyBible: story.storyBible,
      referenceAssets: refMap,
      provider: 'GEMINI',
      modelId: 'gemini-3.1-flash-image',
      rateCardSnapshotId,
      executionMode: 'REPLAY',
      fixturePackVersion: 'v1',
      fixtureId: 'default-gemini-image-9-16',
    });

    expect(t1).toEqual(t2);
    expect(t1.prompt).toContain('angle=EYE_LEVEL');
    expect(t1.prompt).toContain('Room — Quiet studio');
    expect(t1.prompt).toContain('Hero — Fictional adult with short dark hair');
    expect(t1.prompt).toContain('Brown coat');
    expect(t1.prompt).toContain('[HERO]');
    expect(t1.prompt).not.toContain('MUST_NOT_APPEAR_IN_PROMPT');
    expect(t1.prompt).not.toContain('extra fingers');
    expect(t1.negativePrompt).toBe('extra fingers, watermark');

    // Role precedence: CHARACTER_REFERENCE before LOCATION_REFERENCE before STYLE_REFERENCE
    expect(t1.inputAssets.map(a => `${a.role}:${a.assetId}`)).toEqual([
      `CHARACTER_REFERENCE:${charRefId}`,
      `LOCATION_REFERENCE:${locRefId}`,
      `STYLE_REFERENCE:${charRefId}`,
    ]);
  });

  it('compiles v1 shot with UNSPECIFIED angle and compiles concise VIDEO I2V prompt with START_FRAME first', () => {
    const v1 = canonicalStoryV1();
    const startFrameId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const charRefId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const bibleV2 = upgradeBibleToV2(v1.storyBible, { group: 'characters', id: 'hero', assetId: charRefId });

    const videoTemplate = compileGenerationTemplate({
      filmId,
      storyRevisionId,
      shotRevisionId,
      shotDependencyHash: 'e'.repeat(64),
      kind: 'VIDEO',
      shotSpec: v1.scenes[0].shots[0].spec,
      storyBible: bibleV2,
      referenceAssets: new Map([[charRefId, { id: charRefId, sha256Hash: '1'.repeat(64), mimeType: 'image/png' }]]),
      selectedStartFrame: { assetId: startFrameId, sha256Hash: '9'.repeat(64), mimeType: 'image/png' },
      provider: 'RUNWAY',
      modelId: 'gen4_turbo',
      rateCardSnapshotId,
      executionMode: 'REPLAY',
      fixturePackVersion: 'v1',
      fixtureId: 'default-runway-video-9-16',
    });

    expect(videoTemplate.camera.angle).toBe('UNSPECIFIED');
    expect(videoTemplate.prompt).toContain('angle=UNSPECIFIED');
    expect(videoTemplate.prompt).not.toContain('EYE_LEVEL');
    // VIDEO prompt omits static Bible description prose while keeping structuredIntent intact
    expect(videoTemplate.prompt).not.toContain('Fictional adult with short dark hair');
    expect(videoTemplate.structuredIntent.subjects[0].description).toBe('Fictional adult with short dark hair');
    expect(videoTemplate.durationSeconds).toBe(5);
    expect(videoTemplate.inputAssets[0]).toMatchObject({ source: 'GENERATED_ASSET', role: 'START_FRAME', assetId: startFrameId });
    expect(videoTemplate.inputAssets[1]).toMatchObject({ source: 'REFERENCE_UPLOAD', role: 'CHARACTER_REFERENCE', assetId: charRefId });
  });

  it('rejects prompt exceeding profile max without truncating', () => {
    const v2 = canonicalStoryV2();
    v2.scenes[0].shots[0].spec.prompt = 'a'.repeat(950);
    expect(() =>
      compileGenerationTemplate({
        filmId,
        storyRevisionId,
        shotRevisionId,
        shotDependencyHash: 'f'.repeat(64),
        kind: 'VIDEO',
        shotSpec: v2.scenes[0].shots[0].spec,
        storyBible: v2.storyBible,
        referenceAssets: new Map(),
        selectedStartFrame: { assetId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sha256Hash: '9'.repeat(64), mimeType: 'image/png' },
        provider: 'RUNWAY',
        modelId: 'gen4_turbo',
        rateCardSnapshotId,
        executionMode: 'REPLAY',
        fixturePackVersion: 'v1',
        fixtureId: 'default-runway-video-9-16',
      }),
    ).toThrow(/COMPILED_PROMPT_TOO_LONG|1000/);
  });
});
