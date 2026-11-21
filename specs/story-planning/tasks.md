# SP-001 tasks
Status: IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF
Source: [Approved specification](spec.md)

## Tasks
| Task | Dependency / scope | Evidence / status |
|---|---|---|
| SP-01a | REQUIRED: spec freeze; FR-02/03/11, DEC-P01/03/04 | Owner authorized v1.1 in chat 2026-11-20; source moved from specs/spec.md |
| SP-01b | REQUIRED: contracts and tests | PASS: contracts build/typecheck; 3 contract tests |
| SP-02a | PREREQUISITE: original FC receipt, read DTO | PASS: FC integration + FC-only upgrade/unsupported rollback |
| SP-02b | REQUIRED: schema/guards/versioned preflight; AT-SP-27 | PASS: PG16 trigger drop/disable/function drift and same-Film constraints |
| SP-03 | REQUIRED: snapshot writer, receipts, ownership | PASS: 20 same-key replay and 20 distinct-key conflict tests |
| SP-04 | REQUIRED: continuity/Bible/waivers; AT-SP-19/28 | PASS: deterministic rules, Bible identity dependency invalidation and waiver scope |
| SP-05 | REQUIRED: lifecycle/security/evidence; AT-SP-29/30 | PASS: authoritative approval evidence, edit race, Host/Origin/session/error envelope |
| SP-06 | REQUIRED: storyboard UI | PASS: production browser canonical approval/history/mobile, draft/conflict recovery |
| SP-07 | REQUIRED: fixture proposal provenance | PASS: FIXTURE provenance API + production UI acceptance |
| SP-08 | REQUIRED: PG16/E2E/review and G1 handoff | PR #5 merged; ruleset-v2 patch local acceptance PASS; patch CI/owner sign-off PENDING |

## Handoff
Baseline: main `fb44d24031f203f288b2c301df4362f599c54258` (PR #5 merged), patch branch `fix/story-continuity-ruleset-v2`.
Registered files and per-task commands/results are recorded here as checks execute.
Rollback: restore prior application only before SP data exists; after SP writes, preserve database/history and use a forward migration. Never remove applied migrations or reset user data.
No finance/provider/queue/SSRF implementation. G2–G5 NOT_IMPLEMENTED.

### SP-01a–SP-05 registered files and evidence
- [contracts](../../packages/contracts/src/story.ts): Bible/ShotSpec/snapshot commands, Expected/Policy/Finding/Storyboard types and canonicalStory fixture; [Film contracts](../../packages/contracts/src/index.ts) retain integer micros while widening read lifecycle.
- [domain](../../servers/src/stories/domain.ts): canonical hashing, reference checks, policy, dependency and STORY_APPROVAL validation. [repository](../../servers/src/stories/repository.ts): command transaction and coherent readStoryboard projection.
- [schema](../../servers/src/db/schema/stories.ts), [SQL](../../servers/src/db/migrations/0001_spicy_thaddeus_ross.sql), Drizzle snapshot/journal and state-2 fingerprint: same-Film FKs, immutable history and append-only audit.
- [migration preflight](../../servers/src/db/migrate.ts): state-versioned finite guard fingerprint; FC migration and state-1 unchanged. [Film repository](../../servers/src/films/repository.ts): durable original create receipt.
- [shared boundary](../../servers/src/http/boundary.ts): boundedJson/installBoundary/requireOperator/resourceId; Film and Story API share transport/session/error rules. [Story API](../../servers/src/http/story-api.ts): protected endpoint group; root application mounts both.
- Tests: [domain](../../servers/src/stories/domain.test.ts), [Story PG16](../../servers/src/stories/story.integration.test.ts), [migration PG16](../../servers/src/db/migrate.integration.test.ts), retained FC/session/health regression suites.

Mapping: FR-02/03/11 and scoped FR-14; DEC-P01/03/04. Existing C4 web/API/database topology retained; no container/service architecture change.
Evidence: Windows, Node 22.23.0, pnpm 11.21.0, Docker PostgreSQL 16 test container at loopback port 55432. Current patch evidence is registered below; local commands are not remote CI evidence.

Source reconciliation: specs/spec.md → story-planning/spec.md (existing user text preserved and amended with owner-approved v1.1); PRD pilot 16:9 proposal → 9:16 (SP-D01). No new competing rule registry; other canonical rules unchanged.
Failures fixed with evidence: waiver timestamp decoding (driver string rather than Date), JSONB receipt key-order comparison, explicit textarea label association. Browser setup respects the production login cooldown and reuses one UI-issued session; limiter unchanged.
Next: publish and review the ruleset-v2 patch. G1 owner acceptance remains pending.

### SP-06–SP-07 registered files and evidence
- [Storyboard](../../clients/components/storyboard.tsx) exports StoryboardWorkspace; Film route mounts it, Brief links to it and unlock redirect permits the protected Storyboard destination. Three-pane zinc/amber editor supports script/Bible/ShotSpec, continuity, keyframe override/transition reasons, accessible reorder, duplicate/remove/move and read-only history.
- [browser suite](../../tests/e2e/story.spec.ts): canonical 45s/eight-shot approve/reload, fork/history, mobile controls, lost-response same-key retry, and stale save preserving tab-local draft. Existing FC browser cases retained.
- `pnpm test:e2e`: PASS, 10 tests (6 FC + 4 Story) against production Next/Hono and PG16. `pnpm --filter @nolen/web test:boundary`: PASS, missing runtime secret and indirect server-only negative build.
- Visual inspection: desktop and 390px browser screenshots generated under test-results; no fake media or financial counters. Artifacts are ignored locally and uploaded by CI.
- Domain file import restriction now includes stories/domain.ts, with direct positive/negative fixtures for its actual path.

### Data flow and failure behavior
Browser drafts use shared contracts → protected Hono Story API → Film lock/receipt/version checks → immutable revision/memberships and deterministic validation → active pointer/receipt committed together. Approval locks the same Film, recalculates validation/policies/hash and binds the effective waiver set. No queue/provider or ledger write exists in this slice.
4xx responses retain editable draft; stale clients reload explicitly. Timeout/5xx retains exact pending command/key in sessionStorage; only definite responses or explicit warned abandonment clear it. Validation has deterministic persisted deduplication without command receipts. Database session errors fail closed with 503.

### Local operation
Use existing FC runbook/toolchain. `pnpm db:migrate` upgrades supported FC rows without resets. Start the existing Compose application with its configured OPERATOR_TOKEN, create/read a Film and follow Open storyboard. Manual plans and labeled fixture proposals share the same validated snapshot writer. Story approval is not video-dispatch approval.

### SP-08 acceptance and review handoff
- Backend implementation commit: `8f709ee`; UI/evidence commit follows it. Checks were executed against this complete working tree, including the UI changes.
- Compose baseline and current patch acceptance are recorded in their respective handoffs below.
- QG-CODE, QG-ARCH, QG-DOMAIN, QG-INTEGRATION and QG-EVIDENCE passed for the implemented G1 scope; exact current counts are recorded in the ruleset-v2 handoff.
- NOT_IMPLEMENTED: paid LIVE planning, VIDEO_DISPATCH validation, financial admission/ledger, provider/jobs, media/export and G2–G5 release acceptance. No provider keys/calls required.
- Read-only implementer review traced spec → contracts → API/auth → Film lock/receipts → snapshot/validation/approval → UI/retry and checked changed callers/tests. Findings fixed: waiver timestamp shape, canonical JSONB receipt comparison, textarea labeling, URL ID errors and actual stories/domain.ts import-restriction coverage. No remaining observed BLOCK or accepted CONTAIN exception; debt tracker unchanged.
- The continuity follow-up review was accepted as patch scope, but post-implementation owner G1 sign-off has NOT been supplied. Local CI-equivalent PASS does not substitute for owner acceptance or remote patch CI.
- Next dependency: review/accept SP-001, then plan the next approved generation/accounting slice; do not start deferred spikes automatically.

Acceptance mapping (implemented evidence, independent acceptance still pending):
- AT-SP-01–08: snapshot/history, duplicate/remove/reorder, concurrency, ownership and invalid inputs → Story PG16 + browser suites.
- AT-SP-09–15: recurring identity-style lock, wardrobe/held-prop, location/light/pose, explicit transitions, bounded waivers and policy/override behavior → domain tests + Story PG16. An OPTIONAL override cannot bypass IDENTITY_LOCK.
- AT-SP-16–19: lifecycle/races, edit-after-approval history and REQUIRED keyframe without asset → PG16 + canonical browser approval.
- AT-SP-20–21: original Film receipt and FC-only migration compatibility → Film/Story/migration PG16 suites.
- AT-SP-22: fixture provenance API and shared strict schema/reference rejection; no LIVE inference claim.
- AT-SP-23–24: connection loss and explicit 5xx after Story commit, same-key replay, stale draft retention, keyboard reorder and 390px layout → production browser suite.
- AT-SP-25–26: target warning/range block and Host/Origin/size/session DB failures → domain + PG16 + retained FC browser checks.
- AT-SP-27: migration trigger/function drift; AT-SP-28: Bible identity dependency invalidation; AT-SP-29: edit/approval/waiver races; AT-SP-30: shared-boundary Hono/browser regression.
This mapping describes automated test scope, not independent acceptance of every product requirement.

Final review correction: recurring characters changing locked style now produce non-waivable IDENTITY_LOCK. Added tests prove a keyframe override cannot bypass it and that duplicate/remove preserves stable-ID history. Validation evidence checks persisted findings against authoritative recomputation before binding its ID to approval. A validation behavior change after release must bump the rule-set version; same-version evidence mismatch fails closed.
Execution notes: initial sandbox network/artifact permissions required approved reruns with the same toolchain. A browser run was blocked by the test Compose project occupying port 3000; only that test project was stopped before rerunning. These were environment/test setup failures, not hidden source regressions or accepted product workarounds.

### Continuity ruleset v2 patch handoff
- **Registered files:** [domain](../../servers/src/stories/domain.ts) enforces story-wide subject identity, single-Shot location binding and unambiguous untargeted transitions; [repository](../../servers/src/stories/repository.ts) resolves approval-linked historical validation and current/fallback evidence; [contracts](../../packages/contracts/src/story.ts) adds `currentRuleSetVersion`; [Storyboard](../../clients/components/storyboard.tsx) synchronizes the single location and labels historical approval evidence. Spec, domain/PG16/browser tests and this handoff changed with them. No DDL, migration, dependency, C4 or debt record changed.
- **Ruleset/evidence:** `story-approval-2` is current. V1 validation and approval remain immutable/readable; revalidation creates a distinct v2 row. Old policy bindings produce `POLICY_RESOLVED`, requiring a successor before approval v2. Approval metadata that cannot resolve its exact validation fails with `REVISION_INTEGRITY`.
- **Verification:** `pnpm test` PASS (3 contract + 18 server tests); `pnpm test:integration` PASS (23 tests / 4 files on isolated PostgreSQL 16); `pnpm lint`, `pnpm typecheck`, `pnpm build` PASS; guardrails PASS 4/4; client runtime boundary PASS 2/2; evidence validators PASS 4/4 plus `check:evidence`; Playwright PASS 10/10; Compose production build/start and smoke PASS with migration ordering, worker independence, restart persistence and durable logout.
- **Negative evidence:** failing tests first reproduced identity after cutaway/Scene, internal location contradiction and multi-character transition suppression. PG16 tests cover save 422/no partial write, legacy v1 read, separate v2 validation, v2 successor approval and corrupt approval metadata fail-closed.
- **Review:** separate read-only diff/caller/test pass found and fixed the Storyboard location-editor conflict, stale v1 spec declaration and inaccurate save error text. No remaining observed BLOCK, CONTAIN exception or new technical debt. Test-only Compose project/volume and PostgreSQL container were removed; unrelated Docker resources and the original dirty checkout were untouched.

### Remote CI and publication handoff
SP-001 base PR #5 is merged at `fb44d24031f203f288b2c301df4362f599c54258`; its post-merge CI succeeded. Ruleset-v2 runtime commit `358197647dde45e237d7c74c89a97281e741b666` is verified by [GitHub Actions run 44862138747](https://github.com/DariusPham857/nolen-ai-short-assistant/actions/runs/44862138747): overall SUCCESS, jobs `film` and `compose` SUCCESS. The patch branch is `fix/story-continuity-ruleset-v2`; PR review and owner G1 acceptance remain PENDING, so SP-001 is not marked DONE. Paid planning, VIDEO_DISPATCH and G2–G5 remain deferred.
