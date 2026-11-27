import { ApiFailure } from '../http/errors.js';
import {
  assertFreePlannerConfig,
  checkFreePlannerPreflight,
  generateGeminiStoryProposal,
  PINNED_FREE_PLANNER_MODEL,
  type FreePlannerEnv,
} from './free-planner.js';

export type SmokeStatus = 'SKIPPED' | 'BLOCKED' | 'PASS' | 'FAIL';

export type SmokeFindingSummary = {
  code: string;
  path: string;
  severity: 'ERROR' | 'WARNING';
  waivable: boolean;
};

export type SmokeSummary = {
  status: SmokeStatus;
  timestampUtc: string;
  model: string;
  billingModel: 'operator-attested';
  preflightStatus: 'SKIPPED' | 'READY' | 'NOT_READY';
  generationRequestsStarted: number;
  durationMs: number;
  scenesCount: number;
  shotsCount: number;
  findingsBySeverity: { ERROR: number; WARNING: number };
  findings: SmokeFindingSummary[];
  errorCode: string | null;
};

export type ParsedSmokeArgs =
  | { ok: true; runLive: boolean; confirmFreeTier: boolean }
  | { ok: false; errorCode: 'FREE_PLANNER_INVALID_ARGS' };

const SMOKE_FIXED_INPUT = {
  brief: 'A short fictional film about an artisan repairing an unbranded brass desk lamp in a quiet evening studio.',
  durationTargetSeconds: 45,
  aspectRatio: '9:16',
} as const;

const ALLOWED_ERROR_CODES = new Set([
  'FREE_PLANNER_INVALID_ARGS',
  'FREE_PLANNER_CONFIRMATION_REQUIRED',
  'FREE_PLANNER_BILLING_UNATTESTED',
  'FREE_PLANNER_UNAVAILABLE',
  'FREE_PLANNER_RATE_LIMITED',
  'FREE_PLANNER_TIMEOUT',
  'FREE_PLANNER_UPSTREAM_FAILED',
  'FREE_PLANNER_CONTENT_BLOCKED',
  'FREE_PLANNER_INVALID_OUTPUT',
]);

function sanitizeErrorCode(err: unknown): string {
  if (err instanceof ApiFailure && ALLOWED_ERROR_CODES.has(err.code)) {
    return err.code;
  }
  return 'SMOKE_UNEXPECTED_ERROR';
}

/** Parse CLI arguments: strip at most one leading `--`, reject duplicates, remaining `--`, and unknown args. */
export function parsePlannerSmokeArgs(argv: string[]): ParsedSmokeArgs {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let runLive = false;
  let confirmFreeTier = false;

  for (const token of args) {
    if (token === '--run-live') {
      if (runLive) return { ok: false, errorCode: 'FREE_PLANNER_INVALID_ARGS' };
      runLive = true;
    } else if (token === '--confirm-free-tier') {
      if (confirmFreeTier) return { ok: false, errorCode: 'FREE_PLANNER_INVALID_ARGS' };
      confirmFreeTier = true;
    } else {
      return { ok: false, errorCode: 'FREE_PLANNER_INVALID_ARGS' };
    }
  }

  return { ok: true, runLive, confirmFreeTier };
}

/** Opt-in live smoke runner with strict gates, zero retries, and allowlisted redacted JSON summary. */
export async function runPlannerSmoke(
  argv: string[],
  deps?: {
    env?: FreePlannerEnv;
    fetchImpl?: typeof fetch;
    now?: () => number;
    generateProposal?: typeof generateGeminiStoryProposal;
  },
): Promise<{ exitCode: 0 | 1; summary: SmokeSummary }> {
  const now = deps?.now ?? Date.now;
  const startedAt = now();
  const baseSummary = (
    status: SmokeStatus,
    overrides: Partial<Omit<SmokeSummary, 'status' | 'timestampUtc' | 'model' | 'billingModel' | 'durationMs'>> = {},
  ): SmokeSummary => ({
    status,
    timestampUtc: new Date(startedAt).toISOString(),
    model: PINNED_FREE_PLANNER_MODEL,
    billingModel: 'operator-attested',
    preflightStatus: 'SKIPPED',
    generationRequestsStarted: 0,
    durationMs: Math.max(0, now() - startedAt),
    scenesCount: 0,
    shotsCount: 0,
    findingsBySeverity: { ERROR: 0, WARNING: 0 },
    findings: [],
    errorCode: null,
    ...overrides,
  });

  const parsed = parsePlannerSmokeArgs(argv);
  if (!parsed.ok) {
    return {
      exitCode: 1,
      summary: baseSummary('BLOCKED', { errorCode: parsed.errorCode }),
    };
  }

  if (!parsed.runLive) {
    return {
      exitCode: 0,
      summary: baseSummary('SKIPPED'),
    };
  }

  if (!parsed.confirmFreeTier) {
    return {
      exitCode: 1,
      summary: baseSummary('BLOCKED', { errorCode: 'FREE_PLANNER_CONFIRMATION_REQUIRED' }),
    };
  }

  const env = deps?.env ?? process.env;
  const fetchImpl = deps?.fetchImpl ?? fetch;

  try {
    assertFreePlannerConfig(env);
  } catch (err) {
    return {
      exitCode: 1,
      summary: baseSummary('BLOCKED', { errorCode: sanitizeErrorCode(err) }),
    };
  }

  const preflight = await checkFreePlannerPreflight({ env, fetchImpl });
  if (!preflight.ready) {
    return {
      exitCode: 1,
      summary: baseSummary('BLOCKED', {
        preflightStatus: 'NOT_READY',
        errorCode: 'FREE_PLANNER_UNAVAILABLE',
      }),
    };
  }

  let generationRequestsStarted = 0;
  const generateProposal = deps?.generateProposal ?? generateGeminiStoryProposal;
  try {
    generationRequestsStarted = 1;
    const result = await generateProposal(SMOKE_FIXED_INPUT, { env, fetchImpl });
    const scenesCount = result.content.scenes.length;
    const shotsCount = result.content.scenes.reduce((sum, s) => sum + s.shots.length, 0);
    const findingsBySeverity = {
      ERROR: result.findings.filter(f => f.severity === 'ERROR').length,
      WARNING: result.findings.filter(f => f.severity === 'WARNING').length,
    };
    const findings: SmokeFindingSummary[] = result.findings.map(f => ({
      code: f.code,
      path: f.path,
      severity: f.severity,
      waivable: f.waivable,
    }));

    return {
      exitCode: 0,
      summary: baseSummary('PASS', {
        preflightStatus: 'READY',
        generationRequestsStarted,
        scenesCount,
        shotsCount,
        findingsBySeverity,
        findings,
      }),
    };
  } catch (err) {
    return {
      exitCode: 1,
      summary: baseSummary('FAIL', {
        preflightStatus: 'READY',
        generationRequestsStarted,
        errorCode: sanitizeErrorCode(err),
      }),
    };
  }
}
