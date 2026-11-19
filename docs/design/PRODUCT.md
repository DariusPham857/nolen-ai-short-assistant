# Product Vision & Experience Context

## 1. Product Overview

`nolen-ai-short-assistant` is a local-first AI-assisted short film production workstation. It empowers independent producers and creative directors to plan, generate, review, assemble, and export a high-quality 30–60 second short film within a strict budget ceiling.

Unlike opaque "one-click" generation platforms, every creative decision (story approval, keyframe validation, model routing, and video clip sign-off) is human-governed, auditable, and backed by an append-only integer-micros financial ledger.

---

## 2. Core Users & Personas

- **The Producer / Demo Operator (Primary User)**:
  - *Needs*: Granular control over script, shot parameters, model selection, and budget reservations.
  - *Frustrations*: Unpredictable AI generation costs, drifting character consistency across cuts, silent failures.
  - *Interaction Style*: High-density dashboard user; prefers keyboard shortcuts, clean status indicators, split-pane inspection, and fast batch commands over decorative fluff.
- **The Creative Reviewer / Benchmark Rater**:
  - *Needs*: Unbiased assessment of visual continuity, motion plausibility, and narrative flow.
  - *Interaction Style*: Side-by-side comparison, blinded asset playback, clear rubric scoring (1–5 scale).

---

## 3. The 7 Core Screens (PRD v1.0 §16.2)

1. **Film Dashboard (`/dashboard`)**: Project selector, stage progression, spent vs reserved vs available budget widget, quick access to active films.
2. **Brief Editor (`/films/[id]/brief`)**: Objective, target audience, duration target (30–60s), aspect ratio (9:16 vertical priority), visual style, max budget cap.
3. **Storyboard Workspace (`/films/[id]/storyboard`)**: Collapsible Scene $\rightarrow$ Shot hierarchy, editable ShotSpecs, continuity in/out diffs, model routing rationale, explicit **Approve Story** gate.
4. **Keyframe Review (`/films/[id]/keyframes`)**: Side-by-side reference asset inspection, deterministic risk policy badges (`REQUIRED` vs `OPTIONAL`), Approve/Reject/Regenerate actions, per-attempt cost preview.
5. **Video Production (`/films/[id]/video`)**: Async generation attempts, live worker state (`QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`), failure reason inspector, single-shot retry without overwriting history.
6. **Final Review & Assembly (`/films/[id]/export`)**: Sequence timeline, clip selection validation, VO/BGM licensed audio track alignment, subtitles burn-in toggle, FFmpeg MP4 export runner.
7. **Cost & Financial Audit (`/films/[id]/costs`)**: Itemized append-only ledger journal, per-shot/per-scene cost breakdowns, pending liabilities reconciliation, AI Usage Manifest generator, all-in-one platform baseline comparison (`MODELED_ONLY` vs `OBSERVED`).

---

## 4. UI Aesthetic & Vibe: "Cinematic Studio Craft"

- **Visual Metaphor**: Professional digital audio workstation (DAW) or non-linear editor (NLE) meets modern developer workstation (Linear, DaVinci Resolve, Runway Studio).
- **Tone**: Focused, authoritative, restrained, high-craft, dark-mode native.
- **Anti-Slop Directives**:
  - NO purple-to-blue AI gradients.
  - NO decorative card-inside-card nesting without functional hierarchy.
  - NO fake metrics, fake reviews, or marketing fluff.
  - Status badges must represent real domain states (`APPROVED`, `QUEUED`, `RESERVED`, `FAILED`), never arbitrary decor.
