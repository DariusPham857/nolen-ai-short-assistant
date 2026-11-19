# Repository Guidelines

## Project Structure

This repository is a scaffold for `nolen-ai-short-assistant` (AI-Powered Cost-Efficient Short Film Production Assistant).
Primary functional specification and architecture baseline: [PRD v1.0](docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md).
Project Context & Challenge Brief baseline: [IT Project Context v1.1](references/gic-2026/GIC2026_IT_Project_Context_v1.1.md) (GIC 2026 × Ecomdy — Challenge 4).

- `clients/` for client applications (Next.js App Router, Tailwind CSS, shadcn/ui).
- `servers/` for server components, background workers, and API services (Node.js, Drizzle ORM, PostgreSQL 16, pg-boss, FFmpeg CLI).
- `scripts/` for repeatable development, database migration, and maintenance commands.
- `docs/` for project documentation, including PRDs and architecture specifications.
- `references/` for supporting benchmarks, rate cards, and challenge briefs.

---

## Challenge Context & Decision Taxonomy

This project addresses **GIC 2026 × Ecomdy — Challenge 4** (AI-assisted, cost-aware, consistency-aware short-film production assistant).
Baseline technical context is tracked in [references/gic-2026/GIC2026_IT_Project_Context_v1.1.md](references/gic-2026/GIC2026_IT_Project_Context_v1.1.md).

### Decision Taxonomy
All requirements, technical discussions, and proposals must use these explicit tags:
- **`[BRIEF]`**: Mandatory constraint directly from the Ecomdy challenge brief.
- **`[DECIDED]`**: Agreed priority or architectural decision locked in PRD / baseline.
- **`[PROPOSED]`**: Recommended technical approach or architecture extension under discussion.
- **`[VERIFY]`**: Requires verification via API spike, benchmark, or team consensus.
- **`[DEFER]`**: Out-of-scope for the current release / MVP.

### Scope Cutting & Feature Priorities
- **Scope Discipline**: A single working, cost-measurable end-to-end vertical slice is strictly prioritized over premature complexity (microservices, Knowledge Graphs, autonomous multi-agents, or contextual bandits).
- **P0 (Must-Have for Demo & Compliance)**:
  1. End-to-end film pipeline (Brief $\rightarrow$ script $\rightarrow$ scenes/shots $\rightarrow$ keyframe approval $\rightarrow$ generation $\rightarrow$ review $\rightarrow$ assembly $\rightarrow$ export).
  2. Continuity P0 (Structured JSON Story Bible & basic continuity checks for character, product, outfit, props, logo, location, lighting, start/end states; human reviewer has final authority).
  3. Keyframe-first + Human Approval (Generate and approve reference keyframes prior to video generation; dedicated route for static pan/zoom).
  4. $\ge 3$ AI image/video tools integrated (Real generation providers: Gemini, Runway Gen-4, fal.ai/Kling; aggregators do not count as independent tools).
  5. Shot-level regeneration & attempt history (Independent shot revisioning without regenerating the entire film).
  6. Cost ledger per attempt (Append-only ledger events, pricing snapshots, tracking unsuccessful/failed runs, idempotency).
  7. Budget guardrail (Atomic reservation before dispatch; `actual_spent` vs `reserved_open` distinction).
  8. Timeline Assembly & Export (30–60s video, 9:16 aspect ratio, VO/BGM/subtitles, deterministic logo/text overlay via FFmpeg).
  9. AI Usage Manifest & licensing (Per-shot/asset model/version, prompt, timestamps, commercial license provenance, AI-generated disclosure).
  10. All-in-one comparison (Methodological comparison report; `MODELED_ONLY` vs `OBSERVED`).
- **P1 (Post-Vertical Slice)**: Calibrated router ($E[\text{cost}] \approx c/(p \cdot d)$), automated visual continuity comparison, rework estimation, version diff UI, ablation studies.
- **P2 (Explicitly Deferred / Banned from MVP Critical Path)**: Obsidian-driven editor, EmbeddingGemma 2, pgvector retrieval, Neo4j / Knowledge Graph DB, GraphRAG, autonomous multi-agents, contextual bandits, causal graphs, self-trained models.

### Production Cost Levers (Order of Impact)
1. **Keyframe-first + human approval** before invoking video generation.
2. **Static shot routing** $\rightarrow$ still image + FFmpeg pan/zoom (bypass video models entirely for low-motion scenes).
3. **Short drafts / low resolution** before full generation/upscaling when supported by providers.
4. **Targeted speaking/lip-sync models** used only when dialogue is required.
5. **Calibrated router** (P1: data-driven model selection once empirical acceptance rates $p_{\text{accept}}$ are known).

### First Vertical Slice Target (The 3-Shot Benchmark)
The initial demonstration milestone is a playable 3-shot 9:16 MP4 video assembling:
1. **Shot 1**: Static shot rendered via still image + FFmpeg pan/zoom.
2. **Shot 2**: Image-to-Video (I2V) motion shot via AI video provider.
3. **Shot 3**: Character/product consistency shot generated using visual reference frames.
All 3 shots must have valid `Attempt`, `Asset`, `AssetReview`, `CostLedgerEvents`, and `UsageManifestEntry` records.

---

## Technical Stack & Topology Baseline

- **Client / Web Application**: Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui.
- **Backend & Background Worker**: Node.js, TypeScript, PostgreSQL 16, Drizzle ORM, `pg-boss` job queue.
- **Media Pipeline & Assembly**: Local filesystem accessed through `StorageAdapter`, FFmpeg CLI for video concatenation, VO/BGM mixing, and subtitle burning.
- **Demo Topology (DEC-P05)**: Single-machine localhost via Docker Compose (`web`, `worker`, `db`). Ingress is strictly bound to `127.0.0.1:3000`. Database and worker internal ports are not published to the host network.
- **Dual Execution Modes (DEC-P05)**:
  - `LIVE`: Makes real provider API calls, enforces real budget reservations, and posts actual financial ledger events.
  - `REPLAY`: Resolves pre-recorded local fixtures with zero financial charges, explicitly labeled `REPLAY` in UI and exports. Never present Replay as live provider success or empirical benchmark evidence.

---

## Domain Model & Structural Hierarchy (DEC-P04)

The application domain follows a strict hierarchical ownership model:

$$\text{Film} \longrightarrow \text{StoryRevision} \longrightarrow \text{Scene} \longrightarrow \text{Shot} \longrightarrow \text{ShotRevision} \longrightarrow \text{Attempt} \longrightarrow \text{Asset} \longrightarrow \text{AssetReview}$$

- **`Film`**: Top-level entity holding brief, budget limit, target duration (30–60s), and active story revision pointer.
- **`StoryRevision`**: Immutable snapshot of ordered scenes and shots, ensuring approval integrity. Structural edits create new revisions.
- **`Scene`**: Narrative and organizational grouping. Scenes **do not** own billable generation attempts or independent authoritative lifecycle states.
- **`Shot`**: Stable logical identity for an individual cut.
- **`ShotRevision`**: Immutable validated ShotSpec (prompt, camera framing, continuity in/out, keyframe policy).
- **`Attempt`**: The atomic billable generation unit (`IMAGE`, `VIDEO`, or film-scoped `TTS`/`ASSEMBLY`). Tied to a specific shot revision, provider, rate card, and financial reservation.
- **`Asset` & `AssetReview`**: Durable media with SHA-256 hash, local path, and append-only producer review decision (`APPROVED` | `REJECTED`).

---

## Engineering Ownership & Responsibilities

Per PRD v1.0 (§8, §16.6, §29.9, §30.8), engineering tasks are divided into two primary disciplines:

### IT 1: Backend, AI Engine, Financial Ledger & Job Orchestration
- PostgreSQL database schemas, Drizzle migrations, and transactional data integrity.
- Atomic budget admission, integer-micros ledger calculations, and row-level locking.
- Transactional Outbox relay and `pg-boss` background worker with crash-recovery safety.
- Multi-provider API adapters:
  - **Google Gemini API** (`gemini-3.1-flash-image`) for keyframes/reference assets.
  - **Runway Developer API** (`gen4_turbo`) for image-to-video.
  - **fal.ai Gateway** (`fal-ai/kling-video/v3/pro/image-to-video`) for image-to-video.
- Deterministic model router (cold-start cost-safe ranking, capability filtering, rate-card snapshots).
- P0 deterministic continuity validator engine.

### IT 2: Frontend, UX, Media Pipeline & Reporting
- Storyboard workspace, nested Scene $\rightarrow$ Shot hierarchy UI, and revision diff views.
- Adhere to the project UI/UX Design System in `docs/design/`: [PRODUCT.md](docs/design/PRODUCT.md), [DESIGN.md](docs/design/DESIGN.md), and [UI Design Workflow](docs/design/UI_DESIGN_WORKFLOW.md) (Three-Pane Workstation layout, dark-mode zinc palette, anti-slop rules, no gratuitous gradients).
- Co-pilot approval gates (Story approval, Risk-based keyframe review, Shot video review, Final export selection).
- Pinned budget status widget (Spent, Reserved, Pending, Available, Limit) and budget increase audit modal.
- Media handling via `StorageAdapter`, SHA-256 asset verification, and secure downloads (SSRF protection).
- FFmpeg video assembly pipeline (playable 30–60s MP4 with VO, licensed BGM, and subtitles).
- Export generators: Itemized cost ledger CSV/JSON, AI Usage Manifest, and baseline comparison report (`MODELED_ONLY` vs `OBSERVED`).

### Shared Contracts
- Unified Zod validation schemas and TypeScript types for ShotSpecs, API error envelopes, and lifecycle transitions.
- Contract-driven integration testing before UI and worker are wired together.

### Collaboration & Development Principles (IT 1 & IT 2)
- **Vertical Slice Focus**: Technical discussions and iterations must prioritize delivering and verifying the P0 vertical slice. Avoid expanding into speculative features unless required by active contracts.
- **Proposal Rigor**: Every technical proposal must identify its goal, trade-offs, dependencies, operational overhead for two engineers, test criteria, and explicit abandonment conditions.
- **Empirical Verification**: Never fabricate or assume model pricing, API endpoints, webhooks, or commercial terms from outdated matrices. Validate against active endpoints, current tier/plan allowances, and empirical test calls.
- **Strict State Separation**: Maintain unambiguous separation between `ShotSpec` (intent), `GenerationRequest` (provider input), `Attempt` (execution run), `Asset` (media output), `AssetReview` (producer sign-off), `CostLedgerEvents` (financial journal), and `RenderJob` (timeline assembly). Never conflate these into a single overloaded entity or status field.

---

## Non-Negotiable Business Rules & Architectural Invariants

Agents and contributors working on this codebase MUST uphold these core rules at all times:

### 1. Cost & Budget Guardrails (DEC-P02)
- **Integer Micros**: All monetary values are strictly stored and computed as integer USD micros (`amount_usd_micros`, where $1\text{ USD} = 1,000,000\text{ micros}$). Floating-point currency arithmetic is prohibited.
- **Reserve-Before-Dispatch**: No billable job may be enqueued or submitted unless a budget reservation is atomically committed under a PostgreSQL row lock (`SELECT ... FOR UPDATE` on `film_budget_accounts`) satisfying:
  $$\text{actual\_spent} + \text{reserved\_open} + \text{next\_reservation} \le \text{budget\_limit}$$
- **Append-Only Ledger**: `cost_ledger_events` is an immutable journal (`RESERVATION_CREATED`, `CHARGE_POSTED`, `RESERVATION_RELEASED`, `CHARGE_CORRECTED`, `RESERVATION_ADJUSTED`). Modifying or deleting cost events is strictly forbidden.
- **Full Realized Cost**: The total cost of a film must account for all billable attempts, including failed, rejected, or regenerated runs.
- **Pending Liabilities**: Unknown or delayed provider charges must be held as `PENDING` rather than assumed to be zero.
- **No Per-Job Cap Bypass**: An explicit operator budget limit increase (with reason and audit entry) is the only valid way to overcome budget exhaustion.

### 2. Approval-Driven AI Co-Pilot Lifecycle (DEC-P01)
- The system operates as an **AI Co-Pilot with explicit approval gates**. Media generation and export cannot proceed without explicit producer sign-off.
- **Three Orthogonal State Machines**:
  1. *Story State*: `DRAFT` $\rightarrow$ `PLANNED` $\rightarrow$ `IN_REVIEW` $\rightarrow$ `APPROVED`. Video generation is blocked until the story revision is `APPROVED`.
  2. *Generation Job State (Attempt)*: `QUEUED` $\rightarrow$ `SUBMITTED` $\rightarrow$ `RUNNING` $\rightarrow$ `SUCCEEDED | FAILED | CANCELED`.
  3. *Asset Review State*: `PENDING_REVIEW` $\rightarrow$ `APPROVED | REJECTED`. Only approved video assets compatible with the active revision are export-eligible.
- Scene progress and bulk statuses are purely **derived projections**, never independent lifecycle states.

### 3. Risk-Based Keyframe Policy & Continuity Gating (DEC-P03)
- Keyframe generation is classified deterministically:
  - `REQUIRED`: For shots with recurring characters, critical wardrobe/props, hero branding, reference-frame animation, or adjacent visual dependencies.
  - `OPTIONAL`: Only for low-risk establishing shots, B-roll, or inserts with no character or continuity links.
- Editing an approved shot creates a new immutable `ShotRevision`, marking downstream asset selections stale until revalidated.
- **P0 Continuity Gating**: Hard checks (character identity lock, wardrobe/prop matching across adjacent shots, lighting consistency, temporal end-to-start continuity) must pass before story approval and video dispatch.

### 4. Provider Dispatch & Idempotency Safety (DEC-P06)
- Every external billable call requires an idempotent `attemptId` and provider request fingerprint.
- If a crash or timeout occurs after remote submission but before persisting the provider job ID, transition to `SUBMISSION_UNCERTAIN` and reconcile. **Never execute a blind resubmission of an ambiguous paid job.**
- Download remote assets immediately to local storage via `StorageAdapter`, verify SHA-256 hashes, and block SSRF (reject private/loopback IPs).

### 5. Assembly & Benchmark Evidence (DEC-P08, DEC-P09)
- Final assembly produces a 30–60s MP4 incorporating only approved video assets in canonical story order, mixed with voice-over, commercially cleared BGM, and subtitles.
- Cost comparisons against an all-in-one platform baseline must be labeled `MODELED_ONLY` if based on price quotes, and `OBSERVED` only when actually executed with identical specifications. Never fabricate cost savings or quality rankings.

---

## Development and Testing Standards

- **Environment Prerequisites**: Docker, Docker Compose, Node.js (LTS), pnpm.
- **Database Testing**: All financial ledger, concurrency, and outbox integration tests MUST run against a real **PostgreSQL 16** instance (e.g. via Docker Compose or test containers). Using SQLite mocks for ledger or row-locking tests is prohibited due to locking and jsonb differences.
- **Verification Criteria**:
  - Every feature must include automated unit tests (deterministic business logic, routing, continuity rules) and integration tests (happy path and negative path).
  - Health endpoints (`/api/health/live` and `/api/health/ready`) must be maintained and verified.
  - Preflight checks must validate Docker services, migrations, StorageAdapter directories, and FFmpeg capability before demo operations.
- **Security & Hygiene**:
  - Never commit `.env`, `.env.local`, API keys, or private tokens. All external secrets must remain server-side and never leak into client bundles, log files, or exported manifests.

---

## Coding Style and Naming

- Use TypeScript with strict type checking enabled across both `clients/` and `servers/`.
- Maintain clear directory structures aligning with the domain entities (`films`, `stories`, `shots`, `attempts`, `ledger`, `providers`).
- Add docstrings or concise comments explaining the purpose, side effects, and invariants of every function and method.
- Follow [Ponytail](https://github.com/DietrichGebert/ponytail) and [Karpathy coding guidelines](https://github.com/multica-ai/andrej-karpathy-skills): keep edits minimal, focused, and define observable verification criteria for each change.

---

## Commits and Pull Requests

1. Start every feature or fix on a new branch from `main` using the branch creator:
   ```bash
   .\scripts\create_branch.ps1 <feature-name>
   # or bash: ./scripts/create_branch.sh <feature-name>
   # manual: git switch -c feature/<feature-name>
   ```
2. Commit each logical code change as soon as it is verified, including corresponding tests. Use [Conventional Commits](https://github.com/conventional-commits/conventionalcommits.org) (or run `.\scripts\commit_changes.ps1`):
   - `feat(scope): add feature description`
   - `fix(scope): resolve issue description`
   - `test(scope): add integration or unit test`
   - `docs(scope): update documentation or specification`
3. Push the branch and open a pull request targeting `main` using the PR creator:
   ```bash
   .\scripts\create_pr.ps1
   # or bash: ./scripts/create_pr.sh
   ```
   Describe the change, enumerate the verification tests executed, and reference the corresponding PRD requirement (e.g. `FR-09`, `DEC-P02`, `AT-P02-01`).

---

## Document and Diagram References

- Include source references in every document and beneath every diagram. Link the specification, decision, or source file that supports the content (e.g., [PRD v1.0 §17](docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md#17-dec-p02--hybrid-budget-guardrail-approved-2026-11-18)).
- For any proposed architecture extension or change to approved decisions DEC-P01 through DEC-P09, explicitly label it as a `[PROPOSAL]` and specify the requirement or trade-off it addresses.
