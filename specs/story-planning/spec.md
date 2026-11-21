# SP-001 — Story Planning & Approval (G1) — Feature Specification

Status: G1_ACCEPTED
Source: [PRD v1.0](../../docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md)

**Status:** `G1_ACCEPTED` — PR #6 merged, merge CI passed, independent acceptance found no BLOCK, and the project owner accepted G1 on 2026-11-21
**Prepared:** 2026-11-20
**Repository baseline:** `main@d4e59c38838776982bf3c5a9fc8be4433eef34b2` (PR #6 merged)
**Owner:** Producer / project owner (implementation authorized 2026-11-20)
**Traceability:** `FR-02`, `FR-03`, `FR-11`, scoped `FR-14`; `MVP-01`, `MVP-02`, `MVP-03`; `DEC-P01`, `DEC-P03`, `DEC-P04`, `DEC-P09`; release gate **G1 Story Ready**.
**Primary sources:** [PRD v1.0](../../docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md) (§§5, 16, 19, 21, 29, 30), [FC-001](../film-creation/spec.md), [AGENTS.md](../../AGENTS.md), [engineering workflow](../../.agents/rules/plan-breakdown-handoff.md), [C4](../../docs/C4-Model/C4_MODEL_ARCHITECTURE.md), [UI workflow](../../docs/design/UI_DESIGN_WORKFLOW.md).

> **Decision taxonomy:** `[DECIDED]` is an already approved product/engineering invariant; `[PROPOSED]` is a technical choice awaiting review; `[VERIFY]` requires repository/test or owner evidence; `[DEFER]` is explicitly outside SP-001. Do not treat this draft, a passing documentation validator, or a proposed API as implementation authorization.

## 1. Goal and observable outcome

An authenticated local Producer opens a Film created by FC-001, constructs or reviews an ordered **Scene → Shot** story plan with a versioned Story Bible, edits ShotSpecs and continuity sheets, receives deterministic P0 consistency findings and explainable keyframe-risk classifications, then explicitly approves a **specific immutable StoryRevision**. A reload shows the same approved version and audit record. Stale edits or approvals cannot overwrite the active revision.

**G1 evidence:** a persistent 30–60 s story plan with ordered ShotSpecs, resolvable identities, zero unresolved blocking P0 findings, server-computed keyframe requirements, and an actor/timestamp/revision-bound Producer approval. **G1 does not mean** providers, budget admission, approved keyframe assets, video jobs, FFmpeg or G0–G5 release readiness exist.

## 2. Scope and dependency classification

| Class | Work / boundary | Why |
|---|---|---|
| **REQUIRED** | Versioned Story Bible, scene/shot hierarchy, validated ShotSpec, immutable content snapshots and revision history | `FR-02`, `FR-03`, `MVP-01` |
| **REQUIRED** | Create initial plan; edit/reorder/duplicate/remove within a **new** story snapshot; preserve stable IDs and old history | `DEC-P04` |
| **REQUIRED** | Deterministic adjacent-shot continuity validator, visible findings, explicit transitions and bounded waivers | P0 continuity; `DEC-P01`, `DEC-P03` |
| **REQUIRED** | Server-derived `REQUIRED|OPTIONAL` keyframe policy with reasons, ruleset version and auditable override | `DEC-P03` (classification only; **no** keyframe generation) |
| **REQUIRED** | Story `DRAFT → PLANNED → IN_REVIEW → APPROVED`, explicit approval of active valid revision, stale-client rejection | `FR-11`, `DEC-P01` |
| **REQUIRED** | Next.js Storyboard Workspace, reload/read-only history, validation/error/approval states, accessible ordering controls | G1 demonstrability |
| **REQUIRED** | Structured **AI planning proposal contract** (schema validation, deterministic test fixtures and review-before-accept); no billable call by default | `FR-02`, PRD `T-009`; see §9 dependency |
| **PREREQUISITE** | Widen FC-001 Film read DTO, retain Film create idempotency on mutable Film; additive migrations and catalog preflight | Existing `filmDto` assumes `DRAFT`/null pointer |
| **PREREQUISITE** | Reuse operator sessions, canonical Host/Origin, error envelope, no-store, PostgreSQL 16 and CI | No parallel auth/API stack |
| **DEFER** | Financial ledger, reservations, paid planning API calls, image/video provider submissions, attempts/assets, keyframe approval, worker jobs | Requires G2/G3 and financial admission |
| **DEFER** | Advanced LLM/vision continuity diagnostics, embedding/graph DB, bulk paid generation, timeline/FFmpeg, dashboard/list, collaborative RBAC | Not needed for G1 |

**Product scope guard:** planning produces creative **intent**, never a paid generation `Attempt`, `Asset`, `CostLedgerEvent` or queue job. No mock/replay output may be labeled as authenticated LIVE AI generation.

## 3. Baseline compatibility (observed on `main`)

- [Film schema](../../servers/src/db/schema/films.ts): `films.active_story_revision_id` exists as nullable UUID **without FK**; Film enum already contains `DRAFT` and `PLANNING`.
- [Film repository](../../servers/src/films/repository.ts): `filmDto()` throws if status is not `DRAFT` or active revision is non-null. `createFilm()` replays the **current Film row** under an existing idempotency key; once Film changes this can break the FC-001 replay contract.
- [Shared contracts](../../packages/contracts/src/index.ts): `filmDtoSchema` constrains status to `DRAFT` and active revision to `null`.
- [Migration preflight](../../servers/src/db/migrate.ts): compares migration history and a finite PostgreSQL catalog fingerprint (`state-N.json`); Drizzle ORM `0.44.7`, Drizzle Kit `0.31.11`. Prior applied migration files must remain immutable.
- [HTTP API](../../servers/src/http/film-api.ts): Hono mounted in Next.js Node runtime, single local-operator session with DB lookup, exact `127.0.0.1:3000` Host and mutation Origin, safe error envelope.
- [UI design](../../docs/design/UI_DESIGN_WORKFLOW.md): three-pane Storyboard Workstation applies **now**, but simulated spent/reserved figures and unavailable generation buttons must not be shown as real capabilities.

**Required regression contract:** after a Film has an active/approved StoryRevision, `GET /api/films/:id` remains successful, and retrying its original FC-001 `POST /api/films` with the same operator/key/payload still returns the contractually correct original Film create receipt (same `201`, ID and `Location`) without a `500`; a different payload still returns `409`. Choose and test a durable receipt/snapshot or an explicitly approved equivalent — do not silently change FC-001 semantics.

## 4. Story model and immutable versioning

### 4.1 Identity and membership

`Film → StoryRevision → (ordered Scene memberships → ordered Shot memberships → ShotRevision)`; a `StoryRevision` captures a complete Story Bible and the ordered mapping of scenes/shots. `Scene` and `Shot` IDs are stable logical identities across revisions; `ShotRevision` IDs identify immutable validated creative content.

[DECIDED] In the active snapshot, each Shot belongs to **exactly one** Scene. Positions are zero-based contiguous within their respective scenes and scene list; sequence numbers are display/order data, **not identity**. Move/reorder retains Shot ID; duplicate allocates a new Shot ID/initial ShotRevision. Removing means omitting membership from a successor snapshot; no referenced history is hard-deleted.

[PROPOSED] Use the small relational model described in PRD §21.2: `story_revisions`, `scenes`, `shots`, `shot_revisions`, `story_revision_scenes`, `story_revision_shots`, plus version-scoped continuity findings and story review/waiver audit. Use composite FKs or equivalent DB-enforced constraints so membership and shot revision cannot cross Films. Physical DDL, uniqueness/index choices and audit representation are frozen by the approved v1.1 contracts below.

### 4.2 Version semantics and state

- Every content change (Story Bible, scene title/narrative/order, shot membership, ShotSpec, policy override or continuity edit) creates a successor **immutable-content** `StoryRevision`; material shot edits create a successor `ShotRevision` as well.
- StoryRevision `contentHash` is computed from canonical versioned content and ordered membership (not JSON insertion order), fixed at creation; persisted bytes/ID references are never rewritten in place.
- Lifecycle metadata **may transition** on the same revision without altering creative content: `DRAFT → PLANNED → IN_REVIEW → APPROVED`. `mark-planned` validates minimum story structure and makes `DRAFT → PLANNED` explicit; `submit-review` advances `PLANNED → IN_REVIEW`; approval advances `IN_REVIEW → APPROVED`. A failed validation does not advance state. The approval event records `storyRevisionId`, content/dependency hash, `actorId`, decision and timestamp.
- An edit after approval forks a **new DRAFT successor**. Old approved revision and approval event remain in history but are no longer sufficient for generation against the new active pointer.
- `Film.activeStoryRevisionId` points to the current working/approved snapshot. `Film.status=PLANNING` is the proposed Film-level projection while planning/reviewing; do not collapse Film state and StoryRevision state.
- No Scene-level approval state or independently billed Scene Attempt is created.

### 4.3 Concurrency, ownership and idempotency

[PROPOSED] Every write includes `expectedStoryRevisionId` (nullable **only** for first plan creation); shot editing additionally supplies `expectedShotRevisionId`. Under a PostgreSQL `READ COMMITTED` transaction, serialize Film plan-pointer changes with a Film row lock or equivalent compare-and-swap, validate expected revisions **after acquiring protection**, insert all new snapshot members and audit rows, switch the active pointer, then commit before response. Stale input returns `409 VERSION_CONFLICT`/`STALE_REVISION`; never silently auto-merge or overwrite.

Requests are authorized against the existing `local-operator` and the Film's operator ownership; cross-Film scene/shot references are rejected. Retried mutation creation uses a request key and canonical request hash or an explicitly approved equivalent to avoid creating duplicate successor snapshots after response loss. A reused key with changed payload is a conflict. No generic event sourcing framework is required.

### 4.4 Approval and review decision

Only the **currently active** `IN_REVIEW` revision may be approved, after the authoritative server rechecks snapshot hash, referential validity, story total duration, all blocking P0 continuity findings/valid waivers and effective keyframe policy. Approved content is not overwritten. Duplicate approval retries cannot create competing approval events; concurrent edit vs approve produces exactly one valid winner, the other receives a stale/conflict response. `actorId` is the authenticated internal operator; client-supplied approval/actor/timestamps are not trusted.

**Important gate separation:** Story approval does **not** require an already generated/approved keyframe. The `REQUIRED` keyframe must be approved **before VIDEO dispatch** in a later feature; requiring it at story approval would create a circular dependency. At G1, validate that the keyframe policy is resolved with rule provenance; provider capability/asset eligibility checks run at their later admission gates.

## 5. Versioned Story Bible, ShotSpec and continuity

### 5.1 Story Bible (logical JSON contract)

The versioned Story Bible for a Film/StoryRevision contains nonempty narrative/visual style context plus stable, within-Film IDs and typed definitions for: `characters` (identity traits, reference binding when available), `wardrobes`, `props` (incl. brand/hero identity when relevant), `locations` (time/light geography), and `styleRefs`. External asset IDs are **optional** at planning time and must never be represented as approved assets without actual asset/review records. Missing referenced IDs are blocking schema findings.

[PROPOSED] A versioned Zod schema and normalized serializer live in `@nolen/contracts`; server computes hashes, identity resolution and derived fields. Add canonical `schemaVersion`/ruleset versions, default bounds and field-level limits only after contract review. Do not pretend PRD's illustrative JSON IDs are production UUIDs.

### 5.2 ShotSpec (PRD §19.4 semantic baseline)

Each ShotRevision stores an immutable, schema-valid ShotSpec containing:

| Field group | Required semantic behavior |
|---|---|
| Identity | `shotId`, `shotRevisionId`, parent Scene/Film/StoryRevision association; all references same Film; server-owned IDs |
| Creative | `shotType` (`CHARACTER`, `ACTION`, `DIALOGUE`, `ESTABLISHING`, `BROLL`, `INSERT`, `PRODUCT`, `OTHER`), positive `durationSeconds`, nonempty `prompt`, optional negative prompt |
| Camera/style | framing, movement, `styleRefId`, `subjectIds`, `locationId`; referenced IDs resolve in versioned Story Bible |
| Continuity | `continuity.start` and `.end` with character wardrobe/pose/held props, location/light/props; explicit `intendedTransitions` for intentional changes |
| Keyframe decision | server-computed `systemRecommendation`, `effectiveRequirement`, `riskFlags`, `ruleSetVersion`, nullable audited override |
| Future routing/bindings | preferred capability and **nullable** selected provider/model/keyframe reference; do not fabricate accepted assets/quotes |

[PROPOSED] Domain validation should keep shot duration positive, enforce canonical order and compute total duration; target is 30–60 s. A mismatch with `Film.durationTargetSeconds` must be visible; whether it blocks approval or is a warning is a **product contract to ratify** (§11). Never silently adjust shot timing.

### 5.3 P0 deterministic continuity gate

Run on every plan save that changes dependencies (or mark affected findings stale) and **always immediately before story approval**, using ordered adjacent shots including cross-scene edges when narrative continuity is declared. Store reproducible findings with `storyRevisionId`, applicable ShotRevision IDs, `dependencyHash`, `ruleSetVersion`, severity, code, affected field path, expected/actual, `waivable` and explanation.

| P0 check | Blocking condition (unless valid intentional transition/waiver) |
|---|---|
| `SCHEMA_VALID` | Missing/foreign Story Bible ID, malformed ShotSpec, stale dependencies |
| `IDENTITY_LOCK` | Recurring subject changes locked identity/reference/style unexpectedly |
| `WARDROBE_PROP` | Character wardrobe, held items or continuity-critical prop changes without declared transition |
| `LOCATION_LIGHTING` | Continuous shot edge contradicts location/time/light without explicit scene break/change |
| `TEMPORAL_STATE` | Earlier `continuity.end` contradicts next `continuity.start` (pose, prop ownership, position) |
| `POLICY_RESOLVED` | Keyframe policy lacks derived recommendation/reason/version or valid override provenance |

`ERROR` blocks approval if unresolved. `WARNING` is visible but advisory. Only explicitly waivable findings may be waived; a waiver records operator, reason, finding fingerprint, dependency hash, relevant revision and timestamp, and becomes invalid when its scoped inputs change. Non-waivable foreign references, missing policy and stale revision errors never accept a waiver. Revalidation never retroactively deletes historical findings, decisions or approvals.

**Risk classification (DEC-P03):** `REQUIRED` for recurring/on-screen named character, wardrobe/prop/hero-brand identity, reference-dependent animation, linked visual reference or material unknown risk (`UNKNOWN_RISK`); `OPTIONAL` only for low-risk `ESTABLISHING|BROLL|INSERT` without dependent identity constraints. Save effective requirement and explanations server-side per ShotRevision. Relaxation needs explicit reason and risk acknowledgement, creates a new revision and **does not** bypass continuity checks or future provider hard constraints.

## 6. Approved API contract (v1.1 clarification below)

All routes reuse Hono/Next Node runtime, existing `nolen_session`, exact canonical Host/Origin, request body limits, `Cache-Control: no-store`, safe API error envelope `{error:{code,message,details?,requestId}}`, and operator-scoped Film authorization. Mutations use a canonical request idempotency policy and optimistic revision preconditions. Client never supplies trusted derived approval, risk flags or actor data.

| Route | Intent / response |
|---|---|
| `GET /api/films/:filmId/storyboard` | `200` active snapshot (or explicit no-plan state), ordered Scenes/Shots, Story Bible, state, findings, revision token and history summary |
| `GET /api/films/:filmId/storyboard/revisions/:revisionId` | `200` historical immutable snapshot and approval evidence; `404` for foreign/missing ID |
| `POST /api/films/:filmId/storyboard/revisions` | `201` initial or successor full ordered snapshot; input `{expectedStoryRevisionId, expectedStateVersion, content:{script, storyBible, scenes:[...]}}`; old IDs preserved, server assigns new revision IDs |
| `POST /api/films/:filmId/continuity/validate` | `200` deterministic findings for active/current request revision; no approval side effects |
| `POST /api/films/:filmId/storyboard/mark-planned` | `200` transition `DRAFT → PLANNED` after complete structural/schema validation against the expected revision; no approval side effects |
| `POST /api/films/:filmId/storyboard/submit-review` | `200` transition `PLANNED → IN_REVIEW` against expected active revision, after required shape/readiness checks |
| `POST /api/films/:filmId/storyboard/approve` | `200` `APPROVED` with revision ID/approval evidence; if blocking findings, `422 CONTINUITY_BLOCKED`; if stale, `409` |
| `POST /api/films/:filmId/storyboard/plan-proposals` | `[PROPOSED]` fixture-backed structured suggestion and validation results, **not** a committed StoryRevision nor LIVE inference; an accepted proposal is saved via revisions endpoint |

[PROPOSED trade-off] A **full-snapshot successor write** is simpler and transactionally safe for a 6–10-shot MVP than all granular scene/shot mutation routes proposed in PRD §21.7. It still supports add/edit/reorder/duplicate/remove through the UI. The owner approved this full-snapshot shape in v1.1; PRD §21.7 examples remain illustrative. Reject excessive payloads and unsupported content types before JSON parsing.

**Error compatibility:** preserve FC-001 `400 INVALID_ID/INVALID_JSON`, `401 UNAUTHORIZED`, `403 HOST_REJECTED/ORIGIN_REJECTED`, `404`, `405`, `409 VERSION_CONFLICT/STALE_REVISION/IDEMPOTENCY_CONFLICT`, `413`, `415`, `422 VALIDATION_ERROR/CONTINUITY_BLOCKED`, `503 DATABASE_UNAVAILABLE` and safe `500`. Return field-path details and findings only when safe; never leak DB SQL or secrets. Every unexpected DB lookup failure is `503`, not a fake authorization failure.

## 7. Data migration, read model and backward compatibility

- Add Story/Scene/Shot/ShotRevision and approval/waiver/finding schema via **additive** Drizzle migrations; apply only after FC-001 migrations. Add FK for `films.active_story_revision_id` once the referenced table exists; preserve existing Film rows and nullable pointers.
- Update `servers/src/db/schema/index.ts`, Drizzle SQL, journal and finite `state-N.json` catalog evidence as a coordinated change; never edit a previously applied migration or auto-reset a legacy database. Verify empty DB, FC-001 DB plus sentinel Films, repeat migrate, and drift rejection against PostgreSQL 16.
- Extend shared `FilmDto`/read serializer to represent both FC-001 DRAFT/null and later PLANNING/non-null states; include active revision metadata only if contract approved. Keep create-film input and money micros intact.
- Preserve **original create idempotency receipt semantics** across Film state transitions. Regression tests must cover `GET Film` after approval and duplicate original create.
- Add relevant indexes/constraints so a StoryRevision cannot reference a ShotRevision from a different Shot/Film, and a Shot cannot have two Scene memberships in the same snapshot. History remains queryable after reorder/remove.
- Domain server—not client JSON—owns canonical hashes, revision sequence/version, timestamps and approval actor; no direct browser DB imports.

## 8. Storyboard UI (IT 2)

- Route: `/films/[id]/storyboard` with a responsive three-pane workflow: Scene/Shot tree, active storyboard canvas, ShotSpec/continuity inspector. On smaller screens collapse panels without losing access to actions.
- Provide an accessible initial-plan state, scene/shot add/edit/duplicate/remove, reorder with **keyboard move up/down / move to scene** alternatives, clear dirty/pending/saved state, and history read-only access.
- Show Story Bible identities, continuity `start → end`, blocking findings and field paths, rule explanations for `REQUIRED|OPTIONAL`, changes/waivers and total-vs-target duration.
- Distinguish `DRAFT`, `PLANNED`, `IN_REVIEW`, `APPROVED`; approval button shows the exact version to be approved and requires explicit confirmation. Show a stale/409 banner with reload/diff or retry-after-reconcile workflow; never overwrite unseen changes.
- Keep work on failed validation or network timeout; retries use same mutation request identity while outcome is uncertain. Redirect unauthenticated operator to existing unlock flow and restore non-secret local draft where feasible.
- Reuse zinc/amber, typography and accessibility rules. Do not render synthetic cost, spent/reserved/available, provider selection results, media thumbnails or generation buttons as if implemented. Only show **persisted** budget limit if useful.

## 9. AI planning proposal boundary and G2 dependency

[DECIDED] PRD §§4, 16, 30 requires AI-supported brief → structured story/ShotSpec proposals as part of the **eventual P0 product**. The Producer reviews/edits and explicitly approves; LLM output never becomes authoritative simply because it parses as JSON.

[PROPOSED for SP-001] Freeze `StoryPlanProposal` input/output Zod contracts and deterministic fixtures; support validating a fixture/proposal and accepting it through normal revision writer. Add adapter interface boundary (input: Film brief, duration, ratio, current Bible/revision if any; output: schema-versioned proposed story, provider provenance when LIVE, validation diagnostics), but **do not call a paid LLM** in routine G1 implementation/CI.

**Billing blocker:** PRD §16.1 requires billable LLM usage to be accounted for; G2 financial admission/ledger does not exist yet. Do not send billable planning requests or record hypothetical cost as actual. Real Gemini/LLM planning implementation/smoke evidence must be separately enabled only after a verified accounting policy is approved (or a separately authorized, documented no-charge execution path). Fixture PASS is **not** FR-02 LIVE AI-generation evidence. When enabled later, use provider's documented structured JSON schema feature, revalidate with domain Zod, enforce request size/timeouts, bounded retry policy and no secrets/client exposure.

## 10. Acceptance matrix / verification

The following are **planned tests, not executed PASS evidence**. Record command, environment, commit, status and negative case in `specs/story-planning/tasks.md` during implementation under [SDD-Lite](../../.agents/rules/plan-breakdown-handoff.md).

| ID | Given / when | Expected result / layer |
|---|---|---|
| `AT-SP-01` | FC-001 Film without plan; create initial StoryRevision and reload | Snapshot persists, active pointer resolves, Film GET succeeds; PG16 + browser |
| `AT-SP-02` | Save ordered Scenes/Shots with stable IDs | Zero-based contiguous positions, unique membership, valid same-Film references; PG16 |
| `AT-SP-03` | Edit prompt or Story Bible | New immutable ShotRevision/StoryRevision; old bytes/hash still readable; PG16 |
| `AT-SP-04` | Reorder/move between scenes | Stable Shot IDs, new snapshot and adjacency revalidation; PG16/E2E |
| `AT-SP-05` | Duplicate/remove Shot | Duplicate new ID/no inherited approval; removal excludes only from new membership; historical data intact |
| `AT-SP-06` | Two concurrent writes with same expected revision | One wins, other `409`; no lost update/duplicate current revision; PG16 |
| `AT-SP-07` | Wrong Film/operator/missing session/stale ID | No cross-Film mutation or unauthorized read; safe 401/404/409 responses |
| `AT-SP-08` | Invalid Story Bible/ShotSpec/reference or duplicate scene position | 422; no partial story writes; PG16/API |
| `AT-SP-09` | Recurring character changes locked identity without transition | `IDENTITY_LOCK` ERROR blocks approval; deterministic unit + API |
| `AT-SP-10` | Adjacent wardrobe/held prop mismatch without transition | `WARDROBE_PROP` ERROR blocks approval |
| `AT-SP-11` | Location/lighting contradiction or end→start temporal conflict | `LOCATION_LIGHTING`/`TEMPORAL_STATE` finding blocks approval |
| `AT-SP-12` | Explicit valid intentional transition | No false positive on that edge; provenance preserved |
| `AT-SP-13` | Waivable finding with actor/reason/fingerprint | Valid waiver permits review; changed dependency invalidates old waiver; nonwaivable stays blocked |
| `AT-SP-14` | Risky character/brand/unknown shot vs safe B-roll | REQUIRED/OPTIONAL deterministic with reasons and rule version; no client override of derived risk |
| `AT-SP-15` | Producer changes effective policy with approved justification | New revision/audit, no continuity bypass; stale overrides rejected |
| `AT-SP-16` | Valid DRAFT advances through mark-planned, submit-review, approval and reload | PLANNED/IN_REVIEW/APPROVED transition guards persist; approval has actor/revision/hash/time; no worker/provider/ledger side effects |
| `AT-SP-17` | Try approve draft, stale or continuity-blocked revision | 409/422, no misleading approval event; concurrent edit/approve serialized |
| `AT-SP-18` | Edit a previously approved StoryRevision | Successor DRAFT; historical APPROVED retained, new pointer not auto-approved |
| `AT-SP-19` | Story has REQUIRED keyframe but no asset yet | Story can be approved if its planning/continuity guards pass; future VIDEO dispatch still blocked until keyframe approval |
| `AT-SP-20` | Film moved to PLANNING with non-null revision | GET Film and duplicate original FC-001 POST return correct DTO/create receipt, not 500 |
| `AT-SP-21` | Existing DB with FC-001 Film sentinel; apply new migration twice | Preserves Film/session data; journal/catalog correct; schema drift fails safely |
| `AT-SP-22` | Fixture proposes malformed/foreign-ID story or uses fake LIVE result | Validation rejects; no committed approval or forged LIVE/accounting claim |
| `AT-SP-23` | Browser saves, receives timeout/5xx after commit, retries same request identity | One successor, same revision result; no silent duplicate branch |
| `AT-SP-24` | Keyboard-only/mobile user edits/reorders and reviews errors | Accessible actions; 390px layout usable; form content retained on 409/422 |
| `AT-SP-25` | Film plan duration deviates from target or is outside 30–60 s | Display exact sum, expected warning/block per approved duration contract; no silent auto-adjust |
| `AT-SP-26` | Unauthorized Origin/Host, oversized JSON, DB outage | Existing FC-001 security/error guarantees remain; no partial writes |

**Mandatory evidence:** Zod/continuity/policy deterministic unit tests; PostgreSQL 16 migrations, FKs, transactions, 20-way stale/concurrent test as feasible; Next/Hono/real DB Playwright create/edit/approve/reload; negative import boundaries; clean `pnpm install --frozen-lockfile`, lint/typecheck/build, docs validators and CI. `test:e2e` must not use mock persistence as proof. No paid provider calls in CI. Recheck FC-001 regression suite after Film DTO and migration changes.

## 11. Decision history — resolved by owner approval

| ID | Status | Decision required / recommendation | Blocks |
|---|---|---|---|
| `SP-D01` | **RESOLVED — see approved v1.1 contracts** | **Canonical film:** initial PRD pilot proposed 16:9; owner chose 45s / eight shots / 9:16. PRD §29.2 has been explicitly aligned to this choice. | Canonical G1 fixture/sign-off |
| `SP-D02` | **RESOLVED — see approved v1.1 contracts** | **G1 completion:** PRD §30.3 requires approved canonical 45s/8-shot (or compliant 30–60s) story. **Recommend** 3-shot fixture for fast tests only, 8-shot/45s as acceptance evidence; not interchangeable. | G1 evidence |
| `SP-D03` | **RESOLVED — see approved v1.1 contracts** | **API write granularity:** full-snapshot successor endpoint (§6) vs PRD §21.7 granular Scene/Shot routes. **Recommend full snapshot** for demo-sized storyboard; approve names, limits, idempotency receipt. | API/UX implementation |
| `SP-D04` | **RESOLVED — see approved v1.1 contracts** | **Schema freeze:** IDs, JSON shape/bounds, `StoryBible`/ShotSpec schema version, immutable content vs lifecycle metadata, approval event representation and FK strategy. **Recommend PRD §19.4/§21.2 semantics** without premature extra tables. | Contracts/migrations |
| `SP-D05` | **RESOLVED — see approved v1.1 contracts** | **Duration approval guard:** enforce positive per-shot durations and 30–60s total; decide whether deviation from Film target is blocker or warning. **Recommend** target mismatch WARNING, out-of-range total ERROR at approval. | Validator/approval |
| `SP-D06` | **RESOLVED — see approved v1.1 contracts** | **FC-001 DTO/idempotency compatibility:** design persistent original create receipt (or proven equivalent) and broaden Film read DTO before pointer/status changes. | Any new plan persistence |
| `SP-D07` | **RESOLVED — see approved v1.1 contracts** | **AI planning execution boundary:** approve fixture-first G1 and forbid billable LLM before G2 accounting; name later approved provider/inference budget policy. **Do not claim LIVE planning verification yet.** | External AI planning calls, full FR-02 demo claim |
| `SP-D08` | **RESOLVED — see approved v1.1 contracts** | **Continuity waiver semantics:** exact waivable codes, transition vocabulary, dependency fingerprint, stale invalidation and audit. **Recommend conservative P0 block** for unknown/foreign references. | Approval validation |

**Not a blocker to a draft spec:** final provider pricing/model IDs, queue/recovery, keyframe/media APIs, FFmpeg, cost router and G2–G5 acceptance are deliberately deferred. SP-D01–SP-D08 were resolved by owner approval of v1.1 on 2026-11-20; the approved contracts below supersede these original recommendations. See [tasks](tasks.md) for implementation evidence. Do not change DEC-P01–P09 through a feature-spec edit.

## 12. Definition of Done and handoff

**SP-001 implementation DoD:** satisfied for the G1 scope at `main@d4e59c38838776982bf3c5a9fc8be4433eef34b2`: immutable story/shot planning, deterministic P0 continuity validation, revision-bound approval, required automated evidence, additive migration checks, FC-001 regression coverage, independent read-only review and owner sign-off are recorded in [tasks](tasks.md).

**G1 pass** needs approved canonical film package and acceptance evidence from the correct active StoryRevision. **Full AI planning LIVE** and **G2–G5** remain separately gated. Green docs/CI on this draft alone is not feature completion.

### External technical references (supporting, not project decisions)

- [PostgreSQL 16 explicit locking](https://www.postgresql.org/docs/16/explicit-locking.html) and [transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html): concurrency strategy basis.
- [Drizzle migrations](https://orm.drizzle.team/docs/migrations): additive migration workflow; **repository-pinned version and finite preflight** remain controlling.
- [Google Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output): future validated planner adapter capability; not authorization to call paid APIs.


## Goal
Implement the G1 Story Planning slice described above. Source: [PRD](../../docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md).

## Scope
Manual and fixture planning, immutable snapshots, validation and approval only. Paid inference and VIDEO_DISPATCH implementation are deferred.

## Invariants
### Approved v1.1 contracts (supersede OPEN recommendations above)
Owner authorization: conversation instruction “Please implement the plan”, 2026-11-20.
SP-D01/02: canonical 45s, eight shots, 9:16; three-shot fixture is a fast check only.
SP-D03: full-snapshot successor; SP-D05: target mismatch WARNING, total outside 30–60 ERROR.
SP-D07: fixture-first G1; SP-D08: only wardrobe and held-prop findings are waivable.
SP-D04/06: contracts below approved together with Implementation Plan v1.1.

- All writes lock Film before revision; durable command receipts are checked before stale tokens. Same key/different command or input is 409.
- Each successor starts stateVersion 0; lifecycle and waiver mutations increment it. Validation/replay do not.
- Composite Film/Shot/Revision foreign keys enforce ownership, immutable creative fields and memberships; lifecycle changes remain possible. Approval and waiver history are append-only.
- FC create receipts preserve original DTO and timestamps after Film changes. Unsupported legacy data blocks backfill.
- STORY_APPROVAL validates schema, Bible references, identity, wardrobe/props, lighting, temporal continuity, duration and keyframe classification. It never requires media assets or provider execution.
- VIDEO_DISPATCH adds keyframe eligibility and provider/version compatibility; contract only, NOT_IMPLEMENTED here, unsupported requests are rejected.
- Validate persists deterministic results unique by revision/context/dependencyHash/ruleSetVersion, requires expected tokens but no Idempotency-Key/command receipt, and does not increment stateVersion.
- Bible bindings are in dependency hashes. A changed referenced definition or derived policy creates a new ShotRevision; adjacency changes trigger story revalidation. Waivers never carry into successors.
- Approval reruns authoritative validation under Film lock and stores content/dependency hashes, rule version, validation ID, waiver IDs/hash, actor/time/decision. No waivers may be added to APPROVED revisions.
- Shared Film/Story guards enforce Host/Origin/session/bounded JSON/no-store/requestId error envelopes. Session storage failure is 503, invalid session 401, foreign Film 404.
- Migration inspectors are versioned by applied state. Existing FC migration/state-1 remain unchanged; new fingerprints cover application guard functions/triggers/enabled state, excluding internal triggers.

## Acceptance criteria
AT-SP-01–26 above plus AT-SP-27 guard drift, AT-SP-28 Bible invalidation, AT-SP-29 approval/waiver/edit races, AT-SP-30 shared security. PG16 tests cover same-key replay and distinct-key concurrency, direct SQL immutability and legal lifecycle updates. Browser evidence covers canonical approval/reload, editable history and uncertain retry. No generation side effects.

## Open Questions / Blocked Contracts
No remaining G1 implementation contract decisions. VIDEO_DISPATCH, paid inference and G2–G5 remain deferred, not passed. G1 acceptance and independent review completed on 2026-11-21; their evidence is recorded in [tasks](tasks.md).


### Frozen transport details
[DECIDED] Runtime definitions: [contracts](../../packages/contracts/src/story.ts); relational implementation: [schema](../../servers/src/db/schema/stories.ts). Both Bible and ShotSpec schemaVersion are `1`; current rule set is `story-approval-2`.
Story input is `{expectedStoryRevisionId, expectedStateVersion, content:{script,storyBible,scenes}}`. Existing shots carry `id` and `expectedShotRevisionId`; new scenes/shots carry unique `clientRef`, with IDs assigned by the server. Server strips optimistic Shot tokens from persisted creative content.
Bounds: 1–10 nonempty scenes, at most ten total shots, shot durations integer 1–60s, script 20,000 chars, prompt 2,000, negative prompt 1,000, names 255, definition/continuity text 2,000, max 32 definitions per Bible group, keys max 64 chars, JSON request max 512KiB.
Validation context participates in the evidence unique key. Persisted snapshot reads include scene/shot IDs, derived policies, revision/version tokens, findings, waiver reasons and approval evidence. Fixture proposal provenance is explicitly FIXTURE with liveInference=false; it is not paid provider output.

Story Approval rule clarification: recurring character continuity retains its locked visual identity style. A style-reference change across ordered on-screen appearances produces non-waivable IDENTITY_LOCK; a keyframe override cannot bypass it. Mark-planned/submit-review require valid structure and persist findings for review; only approve requires all ERROR findings resolved by correction, declared valid transitions or eligible waivers. After release, validation behavior changes require a new rule-set version; stored evidence cannot be overwritten under an existing version.

### Continuity ruleset v2 contract

[DECIDED] `story-approval-2` is the current G1 ruleset. A recurring character's first ordered on-screen appearance (`subjectIds`) locks its `styleRefId` for every later appearance, including after B-roll and across Scene boundaries. Identity locks are non-waivable and cannot be bypassed by transitions or keyframe overrides.

[DECIDED] SP-001 models one location per Shot. `ShotSpec.locationId`, `continuity.start.locationId`, and `continuity.end.locationId` must be equal. A location transition explains a cut between adjacent Shots; it never legitimizes contradictory location fields inside one Shot. Multi-location action within a Shot requires a future versioned contract or must be split into separate Shots.

[DECIDED] An untargeted `intendedTransition` suppresses a continuity mismatch only when exactly one mismatch exists for that field on the adjacent-shot edge. If multiple characters mismatch the same field, the transition is ambiguous and suppresses none. `ShotSpec.schemaVersion` remains `1`; targeted transitions are deferred until justified by a separate contract change.

[DECIDED] Validation evidence is immutable per ruleset, while current G1 validity is evaluated against the current ruleset. Approval evidence continues to resolve its exact validation run and version. A v1 approval remains historical evidence but does not establish G1 under v2. Revalidating an old revision creates separate v2 evidence; stale v1 policy/dependency bindings require a successor with v2 ShotRevision policies before approval.
