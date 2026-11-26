import { describe, expect, it, vi } from 'vitest';
import { ApiFailure } from '../http/errors.js';
import { parsePlannerSmokeArgs, runPlannerSmoke } from './planner-smoke.js';

function validProposalJson() {
  return JSON.stringify({
    script: 'Secret creative script text that must not appear in summary.',
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
  });
}

describe('FP-04 / FP-AT-06 planner smoke CLI & runner (R0/R1)', () => {
  it('parses args strictly: strips at most one leading --, rejects duplicates, remaining --, and unknown args', () => {
    expect(parsePlannerSmokeArgs([])).toEqual({ ok: true, runLive: false, confirmFreeTier: false });
    expect(parsePlannerSmokeArgs(['--', '--run-live', '--confirm-free-tier'])).toEqual({
      ok: true,
      runLive: true,
      confirmFreeTier: true,
    });
    expect(parsePlannerSmokeArgs(['--run-live', '--run-live']).ok).toBe(false);
    expect(parsePlannerSmokeArgs(['--', '--', '--run-live']).ok).toBe(false);
    expect(parsePlannerSmokeArgs(['--unknown']).ok).toBe(false);
    expect(parsePlannerSmokeArgs(['positional']).ok).toBe(false);
  });

  it('returns SKIPPED (exit 0, 0 network calls) without --run-live, and rejects bad args even without --run-live', async () => {
    const fetchMock = vi.fn();
    const skipped = await runPlannerSmoke([], { env: {}, fetchImpl: fetchMock as unknown as typeof fetch });
    expect(skipped.exitCode).toBe(0);
    expect(skipped.summary.status).toBe('SKIPPED');
    expect(skipped.summary.generationRequestsStarted).toBe(0);
    expect(skipped.summary.billingModel).toBe('operator-attested');
    expect(fetchMock).not.toHaveBeenCalled();

    const badArgs = await runPlannerSmoke(['--bogus'], { env: {}, fetchImpl: fetchMock as unknown as typeof fetch });
    expect(badArgs.exitCode).toBe(1);
    expect(badArgs.summary.status).toBe('BLOCKED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns BLOCKED (exit 1, 0 network calls) when any opt-in/billing/model gate is missing', async () => {
    const fetchMock = vi.fn();
    const cases: Array<{ argv: string[]; env: Record<string, string | undefined>; code: string }> = [
      {
        argv: ['--run-live'],
        env: { GEMINI_API_KEY: 'k', GEMINI_NO_BILLING_ATTESTED: 'true' },
        code: 'FREE_PLANNER_CONFIRMATION_REQUIRED',
      },
      {
        argv: ['--run-live', '--confirm-free-tier'],
        env: { GEMINI_API_KEY: 'k', GEMINI_NO_BILLING_ATTESTED: 'false' },
        code: 'FREE_PLANNER_BILLING_UNATTESTED',
      },
      {
        argv: ['--run-live', '--confirm-free-tier'],
        env: { GEMINI_NO_BILLING_ATTESTED: 'true' },
        code: 'FREE_PLANNER_UNAVAILABLE',
      },
      {
        argv: ['--run-live', '--confirm-free-tier'],
        env: { GEMINI_API_KEY: 'k', GEMINI_NO_BILLING_ATTESTED: 'true', GEMINI_FREE_PLANNER_MODEL: 'gemini-2.5-pro' },
        code: 'FREE_PLANNER_UNAVAILABLE',
      },
    ];

    for (const c of cases) {
      const res = await runPlannerSmoke(c.argv, { env: c.env, fetchImpl: fetchMock as unknown as typeof fetch });
      expect(res.exitCode).toBe(1);
      expect(res.summary.status).toBe('BLOCKED');
      expect(res.summary.errorCode).toBe(c.code);
      expect(res.summary.generationRequestsStarted).toBe(0);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks generation POST if metadata preflight is not ready (1 GET, 0 POST)', async () => {
    const fetchMock = vi.fn(async () => new Response('unauthorized', { status: 401 }));
    const res = await runPlannerSmoke(['--run-live', '--confirm-free-tier'], {
      env: { GEMINI_API_KEY: 'secret-key-123', GEMINI_NO_BILLING_ATTESTED: 'true' },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.exitCode).toBe(1);
    expect(res.summary.status).toBe('BLOCKED');
    expect(res.summary.preflightStatus).toBe('NOT_READY');
    expect(res.summary.generationRequestsStarted).toBe(0);
    expect(JSON.stringify(res.summary)).not.toContain('secret-key-123');
  });

  it('executes 1 metadata GET + 1 generation POST on ready, returns PASS with allowlisted summary and no secrets/creative text', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'GET') {
        return new Response(JSON.stringify({ name: 'models/gemini-3.5-flash-lite' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: validProposalJson() }] }, finishReason: 'STOP' }] }),
        { status: 200 },
      );
    });

    const res = await runPlannerSmoke(['--', '--run-live', '--confirm-free-tier'], {
      env: { GEMINI_API_KEY: 'fake-secret-token-xyz', GEMINI_NO_BILLING_ATTESTED: 'true' },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.exitCode).toBe(0);
    expect(res.summary.status).toBe('PASS');
    expect(res.summary.preflightStatus).toBe('READY');
    expect(res.summary.generationRequestsStarted).toBe(1);
    expect(res.summary.scenesCount).toBe(1);
    expect(res.summary.shotsCount).toBe(1);
    expect(res.summary.findingsBySeverity.WARNING).toBeGreaterThanOrEqual(1); // 30s vs 45s target
    expect(res.summary.billingModel).toBe('operator-attested');
    expect(res.summary.errorCode).toBeNull();
    const serialized = JSON.stringify(res.summary);
    expect(serialized).not.toContain('fake-secret-token-xyz');
    expect(serialized).not.toContain('Secret creative script text');
    expect(serialized).not.toContain('actualCost');
  });

  it('redacts fake secrets from unexpected errors and disallowed ApiFailure codes', async () => {
    const okGetFetch = vi.fn(async () => new Response(JSON.stringify({ name: 'models/gemini-3.5-flash-lite' }), { status: 200 }));

    const res1 = await runPlannerSmoke(['--run-live', '--confirm-free-tier'], {
      env: { GEMINI_API_KEY: 'leaked-secret-abc', GEMINI_NO_BILLING_ATTESTED: 'true' },
      fetchImpl: okGetFetch as unknown as typeof fetch,
      generateProposal: async () => {
        throw new ApiFailure(500, 'INTERNAL_SECRET_CODE', 'leaked-secret-abc', { secret: 'leaked-secret-abc' });
      },
    });
    expect(res1.exitCode).toBe(1);
    expect(res1.summary.status).toBe('FAIL');
    expect(res1.summary.errorCode).toBe('SMOKE_UNEXPECTED_ERROR');
    expect(JSON.stringify(res1.summary)).not.toContain('leaked-secret-abc');
    expect(JSON.stringify(res1.summary)).not.toContain('INTERNAL_SECRET_CODE');

    const res2 = await runPlannerSmoke(['--run-live', '--confirm-free-tier'], {
      env: { GEMINI_API_KEY: 'raw-error-secret-999', GEMINI_NO_BILLING_ATTESTED: 'true' },
      fetchImpl: okGetFetch as unknown as typeof fetch,
      generateProposal: async () => {
        throw new Error('raw-error-secret-999');
      },
    });
    expect(res2.exitCode).toBe(1);
    expect(res2.summary.status).toBe('FAIL');
    expect(res2.summary.errorCode).toBe('SMOKE_UNEXPECTED_ERROR');
    expect(JSON.stringify(res2.summary)).not.toContain('raw-error-secret-999');
  });
});
