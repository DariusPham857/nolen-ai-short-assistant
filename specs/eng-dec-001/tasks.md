# ENG-DEC-001 tasks and handoff

Status: IN_PROGRESS
Source: [spec](spec.md)

## Tasks
| ID | Class | Goal / dependency | Verification |
|---|---|---|---|
| T1A | PREREQUISITE | Baseline before toolchain changes | Fresh frozen install; existing checks |
| T1B | REQUIRED | Reconcile rules | Diff review, evidence validator |
| T2 | REQUIRED | Exceptions and debt | Positive/negative examples |
| T3 | REQUIRED | Spec/task/PR templates | Evidence validator tests |
| T4A | PREREQUISITE | Typed lint and test typecheck after T1A | lint, typecheck, build |
| T4B | REQUIRED | Import/docs/debt validators | Positive/negative fixtures |
| T4C | REQUIRED | Deterministic health + PG16 connectivity | unit + integration |
| T4D | REQUIRED | CI using local commands after T4A–C | Independent CI run |
| T5 | REQUIRED | Film Creation draft | Spec validator, contract review |
| T6 | REQUIRED | Read-only review and evidence | Diff review, check statuses |

## Handoff

### T1A baseline — 2026-11-19
- Base: origin/main cd22415, backend scaffold merged in PR #2. Working tree clean.
- Windows 10.0.26200; Node 22.23.0; pnpm 11.21.0; server-local workspace.
- Sandbox pnpm auto-install failed with EPERM creating project symlink in sandbox store.
- Same `pnpm --dir servers typecheck` outside sandbox: PASS, frozen existing resolution unchanged.
- Direct installed CLIs: typecheck PASS; unit tests PASS (2 files, 5 tests).
- Baseline lint FAIL: ESLint 9.39.5 could not find eslint.config.js/mjs/cjs.
- Docker executable 29.3.1 exists; daemon initially unavailable (Linux engine pipe absent).
- pg-boss remains 10.4.2; no dependency upgrade proposed. Fresh install/CI evidence follows.

### Rule reconciliation mapping
| Old | New | Reason |
|---|---|---|
| Mandatory split by LOC/files/layers | Coherent testable change; thresholds are review signals | Owner-approved sizing policy |
| Full handoff every small subtask | Compact subtask / full feature-contract-schema handoff | Reduce repetition without losing traceability |
| Example puts all tests last | Tests accompany behavior | Prevent unverified intermediate changes |
| Shortcut comment treated as accepted decision | Reference exceptions policy; approval evidence still required | Prevent silent CONTAIN acceptance |
| Repeated workflow in AGENTS | Link canonical workflow | Avoid rule drift |

Documentation files and responsibilities are registered by the decision's source
table and specs index. They change workflow only, with no product API exports.

### T1B / T2 / T3 / T5 handoff
- Canonical sources: [AGENTS](../../AGENTS.md), [workflow](../../.agents/rules/plan-breakdown-handoff.md),
  [exceptions](../../.agents/rules/engineering-exceptions.md), [decision](../../docs/development/ENG-DEC-001.md).
- Shortcut guidance: [Ponytail rule](../../.agents/rules/ponytail.md),
  [Ponytail skill](../../.agents/skills/ponytail/SKILL.md), [review skill](../../.agents/skills/ponytail-review/SKILL.md).
- Navigation/records: [README](../../README.md), [debt tracker](../../docs/DEBT.md),
  [spec index](../README.md), [verification](../../docs/development/verification.md).
- Templates: [spec](../_template/spec.md), [tasks](../_template/tasks.md),
  [PR](../../.github/pull_request_template.md); this [spec](spec.md) and task record register ENG-DEC-001.
- Film draft: [spec](../film-creation/spec.md), [tasks](../film-creation/tasks.md);
  FR-01/MVP-01, no public API or schema changes; contracts remain blocked.
- `node scripts/check-evidence.mjs`: PASS, 17 engineering documents.
- `node --test scripts/check-evidence.test.mjs`: PASS, 4 tests (spec/task/debt/link negative fixtures).
- Classification examples reviewed: single-worker and test mock ALLOW; undocumented
  material shortcut CONTAIN pending approval; budget bypass BLOCK. No real debt invented.
- Next: finish scaffold checks and obtain independent CI evidence.

### T4A–C handoff
- [Node pin](../../.node-version), [package](../../servers/package.json),
  [lockfile](../../servers/pnpm-lock.yaml), [test typecheck](../../servers/tsconfig.check.json):
  Node 22.23.0, pnpm 11.21.0, added typescript-eslint 8.62.0 only; runtime resolutions unchanged.
- [ESLint](../../servers/eslint.config.mjs), [guardrail tests](../../servers/scripts/check-guardrails.test.mjs):
  typed safety and import restrictions with positive/negative fixtures and empty-suite failure.
- [Evidence validator](../../scripts/check-evidence.mjs), [tests](../../scripts/check-evidence.test.mjs):
  exports validateDocument/validateDebt/validateLinks/checkRepository; local structure only.
- [Health unit tests](../../servers/src/routes/health.test.ts), [PG integration](../../servers/src/routes/health.integration.test.ts):
  deterministic 200/503 and real PG16 version/connectivity. PRD AT-P09-05 scaffold evidence only.
- PREREQUISITE lint repairs: [preflight](../../servers/src/scripts/health-check.ts) validates unknown version value;
  [worker](../../servers/src/worker/index.ts), [shutdown callback](../../servers/src/worker/shutdown.ts),
  [regression tests](../../servers/src/worker/shutdown.test.ts) handle rejected cleanup promises.
  These fix observed typed-lint failures, not queue/recovery implementation.
- First deterministic-test run exposed a fixture bug: returning a mock from beforeEach
  registered it as cleanup; changed hook to return void. Assertions retained.
- `pnpm --dir servers lint`, `typecheck`, `build`: PASS after fixes.
- `pnpm --dir servers test`: PASS, 3 files / 8 tests.
- `pnpm --dir servers test:guardrails`: PASS, 3 tests; empty Vitest discovery exits 1.
- `pnpm --dir servers test:integration`: PASS, 1 PG16 connectivity test against isolated
  container nolen-eng-dec-001-pg16 on localhost:55432. No application database used.
- Fresh main clone in temporary directory: frozen install PASS, typecheck PASS, baseline 5 tests PASS.
- Next: [CI workflow](../../.github/workflows/quality.yml), fresh candidate install, read-only review.

### T4D CI fixture correction
- Fresh candidate ae5c6d8: frozen install and all eight commands in verification.md PASS locally.
- [First CI run](https://github.com/DariusPham857/nolen-ai-short-assistant/actions/runs/44552030627):
  lint/typecheck/build/unit PASS; guardrail fixture FAIL; downstream checks skipped, not PASS.
- Reproduced locally with `CI=true node --test scripts/check-guardrails.test.mjs`:
  no-floating-promises assertion failed. CI single-run type programs used on-disk
  app.ts information for synthetic lintText snippets.
- Replaced those snippets with actual [valid](../../servers/scripts/fixtures/typed/valid.ts)
  and [invalid](../../servers/scripts/fixtures/typed/invalid.ts) files in a small
  [fixture TS project](../../servers/scripts/fixtures/typed/tsconfig.json).
  Same production rules and all assertions retained; no suppression in application code.
- Same CI=true command after repair: PASS, 3/3. Next: rerun independent CI.

### T6 read-only review
- Author performed a separate read-only pass over rules, diff, callers, fixtures,
  and evidence. This is not an independent second-engineer approval.
- No remaining BLOCK found in reviewed implementation; CI completion pending.
- Limits: import checks are scoped static rules, not a graph/security analyzer;
  docs validator checks structure/file links, not source semantics or human approval.
- No finance/queue/recovery/SSRF feature or API contract implemented; no accepted exceptions.
- Rollback: revert this increment's commits; no DB migrations or financial writes.
- Next product task: resolve Film Creation contracts, then approve its implementation plan.
