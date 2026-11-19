# Design System & Craft Specification

## 1. Design Philosophy & Stack Baseline

`nolen-ai-short-assistant` is an authoring tool for filmmakers and producers. The interface prioritizes **clarity, spatial efficiency, auditability, and immediate feedback**.

- **Tech Stack**: Next.js App Router, React 19, Tailwind CSS, shadcn/ui (Radix UI primitives), Lucide React icons.
- **Theme**: Dark-mode native (cinematic studio aesthetic). High contrast ratios (WCAG AAA for text, AA for interactive controls).

---

## 2. Color Palette & Semantic Tokens

### Core Surfaces & Grayscale (Zinc / Obsidian Base)
| Token | Hex Value | Usage |
| :--- | :--- | :--- |
| `background` | `#09090b` (zinc-950) | App workspace backdrop, film canvas surrounding |
| `surface-1` | `#121215` (deep zinc) | Sidebars, navigation panels, toolbar headers |
| `surface-2` | `#18181b` (zinc-900) | Shot cards, modal dialogs, drawer panels |
| `surface-3` | `#27272a` (zinc-800) | Hovered list items, active tab highlights, nested blocks |
| `border-subtle` | `#27272a` (zinc-800) | Separator lines, card outlines |
| `border-prominent` | `#3f3f46` (zinc-700) | Active inputs, focused card states, selected cut |

### Text & Content Hierarchy
| Token | Hex Value | Usage |
| :--- | :--- | :--- |
| `text-primary` | `#f4f4f5` (zinc-100) | Main headings, script text, shot prompts |
| `text-secondary` | `#a1a1aa` (zinc-400) | Field labels, scene descriptions, timestamps |
| `text-muted` | `#71717a` (zinc-500) | Captions, metadata keys, inactive placeholders |

### Semantic State Colors
| Domain Meaning | Palette Token | Hex Values (Bg / Text / Border) |
| :--- | :--- | :--- |
| **Approved / Succeeded** | `emerald` | Bg: `rgba(16, 185, 129, 0.1)`, Text: `#34d399`, Border: `#059669` |
| **Reserved / In-Progress** | `amber` | Bg: `rgba(245, 158, 11, 0.1)`, Text: `#fbbf24`, Border: `#d97706` |
| **Rejected / Over-Budget** | `rose` | Bg: `rgba(244, 63, 94, 0.1)`, Text: `#fb7185`, Border: `#e11d48` |
| **Replay / Simulated Mode** | `violet` | Bg: `rgba(139, 92, 246, 0.1)`, Text: `#a78bfa`, Border: `#7c3aed` |
| **Cinematic Accent (Hero)** | `amber-gold` | Primary button fill: `#f59e0b`, Hover: `#d97706`, Text: `#000000` |

---

## 3. Typography & Typesetting Rules

- **UI & System Font**: `Inter` or `Geist Sans` (`sans-serif`).
  - Heading 1: `text-2xl font-bold tracking-tight text-zinc-100` (Screen titles)
  - Heading 2: `text-lg font-semibold tracking-tight text-zinc-200` (Scene titles, modal headers)
  - Heading 3: `text-sm font-semibold uppercase tracking-wider text-zinc-400` (Section categories)
  - Body: `text-sm leading-relaxed text-zinc-300` (Shot descriptions, prompt inputs)
  - Small / Badge: `text-xs font-medium` (Status pills, duration tags)
- **Technical & Financial Font**: `Geist Mono` or `JetBrains Mono` (`font-mono`).
  - Used strictly for: **Timecodes** (`00:00:15.00`), **Currency Micros** (`$2.400000`), **SHA-256 Hashes** (`sha256:7f8a...`), and **Version Tags** (`v0.4.1`).

---

## 4. Component Patterns & UX Standards

### 1. Pinned Budget Status Widget
Always visible across all production screens (sticky top header or bottom status dock):
- Visual bar segmented into:
  - **Spent (Confirmed)**: Emerald filled bar with numeric USD micros.
  - **Reserved (In-Flight)**: Striped amber bar.
  - **Available**: Zinc-800 remaining track.
- If over-budget: Flashes a prominent **Rose Alert** with numeric shortfall and a dedicated *"Increase Budget"* trigger button.

### 2. State Indicators for 3 Orthogonal State Machines
Never conflate story approval, job attempt execution, and asset review into a single status label:
- **Story State Badge**: `[DRAFT]`, `[PLANNED]`, `[IN_REVIEW]`, `[APPROVED]`.
- **Generation Attempt Badge**: `[QUEUED]`, `[RUNNING]`, `[SUCCEEDED]`, `[FAILED]`, `[UNCERTAIN]`.
- **Asset Review Badge**: `[PENDING REVIEW]`, `[APPROVED]`, `[REJECTED]`.

### 3. Execution Mode Badge (DEC-P05)
- If `mode === 'LIVE'`: Discreet neutral badge `LIVE` with green ping dot.
- If `mode === 'REPLAY'`: Persistent, unmissable violet badge `REPLAY · PRE-RECORDED FIXTURES` to guarantee honest demo presentation.

### 4. Continuity & Risk Badges (DEC-P03)
- `REQUIRED KEYFRAME`: High-contrast warning tag with tooltips explaining the deterministic trigger (e.g., *"Recurring character locked"*, *"Hero prop continuity"*).
- `OPTIONAL KEYFRAME`: Muted tag for establishing / B-roll shots.

---

## 5. Non-Negotiable "Anti-Slop" Craft Floor

1. **No Gratuitous Gradients**: Do not use purple-to-blue or rainbow gradient text or card backgrounds. Use solid, matte dark surfaces with fine 1px borders.
2. **No Empty Placeholder Fluff**: No generic stock quotes, fake user counts, or decorative star ratings. Every displayed metric must derive from the DB or ledger.
3. **No Decorative Nesting**: Cards must not contain unnecessary inner cards unless grouping distinctly ordered sub-entities (e.g., Scene card containing ordered Shot cards).
4. **No Blocking Spinners**: Use skeleton placeholders matching exact layout dimensions. Asynchronous generation runs in the background without locking the UI.
5. **Icon Discipline**: Use Lucide React icons with consistent `size-4` (16px) or `size-5` (20px) and `stroke-width={1.75}`. Never use emojis as UI action buttons.
