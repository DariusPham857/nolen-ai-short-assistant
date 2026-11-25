import { describe, expect, it } from 'vitest';
import { assetDtoSchema, reviewAssetSchema, selectShotAssetSchema, shotAssetSelectionDtoSchema, shotAttemptDtoSchema } from './assets.js';

describe('Asset Contracts', () => {
  it('validates a correct asset DTO', () => {
    const valid = {
      id: crypto.randomUUID(),
      filmId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      shotRevisionId: crypto.randomUUID(),
      kind: 'IMAGE',
      mediaUrl: '/api/assets/123/media',
      sha256Hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      mimeType: 'image/png',
      byteSize: '1048576',
      metadata: { width: 1080, height: 1920 },
      createdAt: new Date().toISOString(),
    };
    expect(assetDtoSchema.parse(valid)).toMatchObject(valid);
  });

  it('rejects invalid sha256 or negative byteSize in asset DTO', () => {
    expect(() => assetDtoSchema.parse({
      id: crypto.randomUUID(),
      filmId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      shotRevisionId: crypto.randomUUID(),
      kind: 'IMAGE',
      mediaUrl: '/api/assets/123/media',
      sha256Hash: 'not-a-hash',
      mimeType: 'image/png',
      byteSize: '-1',
      metadata: {},
      createdAt: new Date().toISOString(),
    })).toThrow();
  });

  it('allows optional reason on APPROVED review, but requires non-empty reason on REJECTED review', () => {
    const approved = {
      decision: 'APPROVED',
      expectedShotRevisionId: crypto.randomUUID(),
      expectedReviewCount: 0,
    };
    expect(reviewAssetSchema.parse(approved).reason).toBe('');

    const rejectedWithoutReason = {
      decision: 'REJECTED',
      reason: '   ',
      expectedShotRevisionId: crypto.randomUUID(),
      expectedReviewCount: 1,
    };
    expect(() => reviewAssetSchema.parse(rejectedWithoutReason)).toThrow(/Reason is required/);

    const rejectedWithReason = {
      decision: 'REJECTED',
      reason: 'Character face is distorted',
      expectedShotRevisionId: crypto.randomUUID(),
      expectedReviewCount: 1,
    };
    expect(reviewAssetSchema.parse(rejectedWithReason).decision).toBe('REJECTED');
  });

  it('validates shotAssetSelectionDtoSchema', () => {
    const assetId = crypto.randomUUID();
    const selection = {
      storyRevisionId: crypto.randomUUID(),
      shotId: crypto.randomUUID(),
      shotRevisionId: crypto.randomUUID(),
      assetId,
      kind: 'IMAGE',
      reviewDecision: 'APPROVED',
      selectedAt: new Date().toISOString(),
      asset: {
        id: assetId,
        filmId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        shotRevisionId: crypto.randomUUID(),
        kind: 'IMAGE',
        mediaUrl: `/api/assets/${assetId}/media`,
        sha256Hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        mimeType: 'image/png',
        byteSize: '1024',
        metadata: {},
        createdAt: new Date().toISOString(),
      },
    };
    expect(shotAssetSelectionDtoSchema.parse(selection)).toMatchObject(selection);
  });

  it('validates selectShotAssetSchema and rejects non-uuid or invalid kind', () => {
    const valid = {
      assetId: crypto.randomUUID(),
      kind: 'VIDEO',
    };
    expect(selectShotAssetSchema.parse(valid)).toMatchObject(valid);

    expect(() => selectShotAssetSchema.parse({
      assetId: 'not-a-uuid',
      kind: 'VIDEO',
    })).toThrow();

    expect(() => selectShotAssetSchema.parse({
      assetId: crypto.randomUUID(),
      kind: 'AUDIO',
    })).toThrow();
  });

  it('validates shotAttemptDtoSchema across all DB attempt states including SUBMITTED and SUBMISSION_UNCERTAIN', () => {
    const validStates = [
      'QUEUED',
      'SUBMITTED',
      'SUBMISSION_UNCERTAIN',
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'CANCELED',
    ] as const;

    for (const state of validStates) {
      const valid = {
        id: crypto.randomUUID(),
        filmId: crypto.randomUUID(),
        storyRevisionId: crypto.randomUUID(),
        shotRevisionId: crypto.randomUUID(),
        kind: 'VIDEO',
        state,
        executionMode: 'REPLAY',
        provider: 'RUNWAY',
        assetId: crypto.randomUUID(),
        latestReviewDecision: 'APPROVED',
        isSelected: true,
        createdAt: new Date().toISOString(),
      };
      expect(shotAttemptDtoSchema.parse(valid)).toMatchObject(valid);
    }

    expect(() => shotAttemptDtoSchema.parse({
      id: crypto.randomUUID(),
      filmId: crypto.randomUUID(),
      storyRevisionId: null,
      shotRevisionId: null,
      kind: 'VIDEO',
      state: 'UNKNOWN_STATE',
      executionMode: 'REPLAY',
      createdAt: new Date().toISOString(),
    })).toThrow();
  });
});
