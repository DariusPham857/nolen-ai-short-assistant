# Plan-First, Recursive Task Breakdown & Documentation Handoff Protocol

This rule governs all software engineering and coding workflows in `nolen-ai-short-assistant`. It enforces three mandatory invariants:
1. **Plan-First**: Always enter plan mode and structure the work before modifying code.
2. **Recursive Task Breakdown**: Keep tasks atomic; continuously split any task that is too large or broad.
3. **Per-Task Coding Handoff & Doc Registration**: Every completed coding task must register its files with project documentation before proceeding.

---

## 1. Plan-First: Always Enter Plan Mode Before Coding

> [!IMPORTANT]
> **Zero blind implementation.** Never write or modify code immediately upon receiving a prompt or feature request without an explicit, approved plan.

Before touching any codebase file:
1. **Analyze Requirements & Invariants**:
   - Trace the request to the corresponding PRD requirement (e.g., `FR-01`, `DEC-P02`, `AT-P09-05`).
   - Identify affected modules, contracts, dependencies, and potential breaking changes.
2. **Draft Implementation Plan**:
   - State assumptions, technical choices, and trade-offs.
   - Lay out the sequence of steps and expected deliverables.
3. **Establish Verification Criteria**:
   - Define exact, observable checks (typecheck, unit tests, integration tests, CLI commands) before writing the solution.

---

## 2. Recursive Task Breakdown: Atomic Granularity

> [!TIP]
> If a task cannot be verified in a single command or touches multiple distinct architectural layers, **it is too large**.

### Sizing Heuristics — When is a task "too large"?
A task MUST be recursively split into smaller sub-tasks if it:
- Touches more than one domain layer simultaneously (e.g., combining DB migration + core engine + API route + UI).
- Expected diff exceeds ~100–150 lines of non-boilerplate code.
- Affects more than 2–3 distinct files across different directories.
- Has multiple distinct verification commands or independent failure modes.
- Cannot be completed and verified in one focused pass.

### Recursive Decomposition Pattern
When a task is too large, break it down hierarchically:
```
Task 1: Implement Feature X (TOO LARGE → Split recursively)
  ├── Task 1.1: Define Zod schemas and TypeScript domain types
  ├── Task 1.2: Database table schema & migration
  ├── Task 1.3: Core business logic / service functions
  ├── Task 1.4: API route & error envelope integration
  └── Task 1.5: Unit & integration tests
```
Execute one sub-task at a time. Do not jump ahead.

---

## 3. Mandatory Per-Task Coding Handoff & Documentation Registration

> [!IMPORTANT]
> **No code change is complete without documentation registration.** Code and documentation must never drift.

At the conclusion of **each** coding sub-task (before moving to the next task), you MUST execute an explicit **Handoff & Registration**:

### The Handoff Checklist
1. **File Registration**:
   - List every created or modified file with its clickable markdown path (`[filename](file:///...)`).
   - Summarize the file's primary responsibility, public exports, and interfaces.
2. **Documentation Mapping**:
   - Map the implementation directly to the relevant documentation:
     - PRD requirement ID / Decision tag (`FR-xx`, `DEC-Pxx`, `AT-Pxx`).
     - Architecture specification (e.g., C4 L1/L2 container or component).
     - Update or reference the appropriate doc file (`docs/PRD/...`, `docs/design/...`, or module README/index).
3. **Verification Evidence**:
   - Report the exact verification command(s) executed (`pnpm typecheck`, `vitest run`, etc.) and their observable output/status.
4. **Handoff State & Next Step**:
   - State the current progress of the overall plan and explicitly declare the next task to be tackled.

### Standard Handoff Format Template
Every task completion update should provide:

```markdown
### 📋 Task Handoff & Documentation Registration: Task [X.Y] — [Task Name]

- **Registered Files**:
  - `[path/to/file.ts](file:///...)`: [Responsibility & main exports]
- **Document References**:
  - PRD / Decision: `[FR-xx / DEC-Pxx]` ([link to doc])
  - Architecture: [C4 Container / Component reference]
- **Verification**:
  - `[command run]`: ✅ [Result summary: X passed, 0 failed]
- **Next Task**: Task [X.Z] — [Name of next sub-task]
```
