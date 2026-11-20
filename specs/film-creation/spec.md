# FC-001 — Film Creation v1.1.1

Status: IMPLEMENTED_ACCEPTANCE_VERIFIED
Source: [PRD FR-01/MVP-01](../../docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md)

## Goal
Authenticated local operator creates a Film and reads it after reload.
Owner approved v1.1.1 and requested implementation on 2026-11-20.

## Scope
REQUIRED: create/read only, Next.js → Hono Node runtime → service → Drizzle → PG16.
PREREQUISITE: workspace, contracts, sessions, migration preflight and CI.
No list/edit/delete, StoryRevision, generation, ledger/account, queue intent or
provider/recovery/SSRF/media work. Worker is not a Film dependency.

## Invariants
[DECIDED] BIGINT / bigint / JSON string, 0 through 9223372036854775807.
New Film DRAFT, null revision, no financial/generation side effects.
Title trim 1–255; brief trim 1–10000; duration integer 30–60; ratio 9:16;
styleNotes optional trim ≤2000, empty →null. Strict object, server-owned metadata.
USD UI ≤6 decimals, no floating arithmetic.

### Auth and security
Canonical http://127.0.0.1:3000; exact Host all requests, exact Origin required on
unlock/create/logout. No forwarded host trust. One local-operator, token ≥32 bytes,
timing-safe digest compare. 32 random byte opaque session; DB SHA256 hex hash,
8h absolute expiry, token SHA256 fingerprint checked each request. Logout deletes
row before success; replay after restart fails. Invalid/revoked/expired →401;
session DB unavailable →503. HttpOnly, SameSite Strict, host-only nolen_session,
Path=/; no __Host- on HTTP. Unlock 5 attempts/minute/process; JSON 4KiB/64KiB
unlock/create bounds enforced before parse including no Content-Length.

### APIs and idempotency
POST /api/operator/session →204; DELETE →204; POST /api/films →201+Location;
GET /api/films/:id →200. Private no-store. Errors {error:{code,message,details?,requestId}}.
400/401/403/404/405/409/413/415/422/429/503/500; safe messages, Allow on 405.
UUID-v4 Idempotency-Key, fixed-order normalized payload SHA256. Film unique
(operator_id,idempotency_key). READ COMMITTED INSERT ON CONFLICT
(operator_id,idempotency_key) DO NOTHING RETURNING; if empty, new SQL SELECT;
equal hash →same 201/id/Location, different →409. Commit before response.
Other unique violation never means replay. No single-snapshot CTE fallback.

### Migration / topology
Drizzle kit 0.31.11 and ORM 0.44.7 format. Preflight verifies every applied
hash/timestamp/order against file prefix and known application schema state.
Empty →initial; valid →pending; unmanaged/drift →SCHEMA_MISMATCH before writes.
No fake baseline/reset or applied migration edits. pg-boss schema handled separately.
Root workspace and lockfile preserve runtime versions. Hono mounted once in Next
Node runtime; server-only bridge, browser-safe contracts. Build without secrets;
runtime startup preflight before readiness. db healthy →migration success →web.
Only host 127.0.0.1:3000. Worker retains existing startup, no Film processing.

## Acceptance criteria
- Unlock/create/read/reload; zero/max/overflow and money precision beyond MAX_SAFE_INTEGER.
- AT-FC-SEC-01: old cookie after logout/restart →401; token rotation →401.
- AT-FC-IDEM-01: 20 duplicate concurrent POSTs →one Film, same IDs/Location.
- AT-FC-IDEM-02: normalized-equivalent replay; changed content →409.
- AT-FC-DB-01: unmanaged schema/journal/hash/schema drift blocked, sentinel intact.
- AT-FC-SEC-02: wrong Host/Origin/missing Origin has no mutation; DB lookup failure →503.
- AT-FC-UI-01: timeout/5xx after commit retains pending payload/key, retry returns old Film.
- Pending sessionStorage restored on reload; no secret. 401 retains for unlock.
  Clear only on 201/definitive refusal or explicit cancel with duplicate-risk warning.
- Request bounds without length, 415/405/429, no-store, correct mount/Node runtime,
  indirect client import rejection; no-secret build but missing token cannot ready.
- Real PG16 migration/concurrency/sessions, Playwright app/DB, CI, worker-independent create.

## Open Questions / Blocked Contracts
None for FC-001. Unmanaged existing DB blocks only its own migration and must be
preserved. Full G0–G5 outside scope.
