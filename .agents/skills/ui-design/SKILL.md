---
name: ui-design
description: >-
  Actionable step-by-step UI/UX design and implementation workflow for nolen-ai-short-assistant.
  Enforces design tokens, anti-slop rules, Three-Pane Workstation architecture, and craft dials.
---

# UI Design Skill for `nolen-ai-short-assistant`

When tasked with creating, editing, or auditing user interface components and pages in `clients/`, execute this multi-step design protocol:

## 1. Load Context & Constraints
1. Read [PRODUCT.md](file:///D:/nolen-ai-short-assistant/docs/design/PRODUCT.md) to understand the screen's persona, job-to-be-done, and place within the 7 core screens.
2. Read [DESIGN.md](file:///D:/nolen-ai-short-assistant/docs/design/DESIGN.md) for authoritative color tokens, typographic scales, and semantic badges.
3. Review [UI_DESIGN_WORKFLOW.md](file:///D:/nolen-ai-short-assistant/docs/design/UI_DESIGN_WORKFLOW.md) for the 6-stage lifecycle and craft dials.
4. Review [AGENTS.md](file:///D:/nolen-ai-short-assistant/AGENTS.md) for non-negotiable business rules (DEC-P01 approvals, DEC-P02 budget integer-micros, DEC-P05 LIVE/REPLAY mode).

## 2. Execute the 6-Step Implementation Flow
- **Step 1 (Scope)**: Identify which of the 7 screens is being built/modified and which domain entities (`Film`, `Scene`, `Shot`, `Attempt`, `AssetReview`) it interacts with.
- **Step 2 (Layout)**: Adopt the Three-Pane Workstation layout (Left: Scene/Shot tree; Center: Preview/Player; Right: Inspector/ShotSpec) with the pinned Budget Status bar at the top/dock.
- **Step 3 (Tokens & Primitives)**: Use shadcn/ui components with Tailwind CSS dark-mode classes (`bg-zinc-950`, `bg-zinc-900`, `border-zinc-800`, `text-zinc-100`). Accentuate primary actions with cinematic gold (`bg-amber-500`).
- **Step 4 (State Separation)**: Always render distinct visual badges for Story state (`DRAFT` $\rightarrow$ `APPROVED`), Generation Attempt state (`QUEUED` $\rightarrow$ `RUNNING` $\rightarrow$ `SUCCEEDED` / `FAILED`), and Asset Review state (`PENDING_REVIEW` $\rightarrow$ `APPROVED` / `REJECTED`).
- **Step 5 (Anti-Slop Audit)**: Apply "The Floor":
  - Zero purple/blue AI gradients.
  - Zero arbitrary emojis as icons (use Lucide React icons only).
  - Zero hardcoded fake metrics or fluff.
  - Skeletons instead of full-screen blocking spinners for async generation.
- **Step 6 (Craft Dial Check)**:
  - If too noisy $\rightarrow$ apply `quieter` (reduce borders, increase padding, mute secondary text).
  - If too flat $\rightarrow$ apply `bolder` (increase heading contrast, punch up primary amber buttons).
  - If too cluttered $\rightarrow$ apply `distill` (remove non-essential metadata chips).
