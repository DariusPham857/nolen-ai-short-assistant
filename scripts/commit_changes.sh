#!/usr/bin/env bash
# ==========================================================
# Automated Conventional Commits script for nolen-ai-short-assistant
# ==========================================================

set -euo pipefail

# Navigate to repo root
cd "$(dirname "$0")/.."

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "=== Running in DRY RUN mode ==="
fi

run_commit() {
  local step="$1"
  local subject="$2"
  local body="$3"
  shift 3
  local files=("$@")

  echo ""
  echo "----------------------------------------------------------"
  echo "[$step] Committing: $subject"
  echo "Files to stage: ${files[*]}"

  if [ "$DRY_RUN" = true ]; then
    echo "[DRY RUN] git add -- ${files[*]}"
    echo "[DRY RUN] git commit -m \"$subject\" -m \"$body\""
    return
  fi

  git add -- "${files[@]}"
  git commit -m "$subject" -m "$body"
}

# Step 1: Script Runner
run_commit "1/6" \
  "chore(scripts): add automated incremental conventional commits runner" \
  "Add commit_changes.ps1 and commit_changes.sh to automate batch conventional commits.
Support dry-run mode and clean status logging." \
  "scripts/commit_changes.ps1" \
  "scripts/commit_changes.sh"

# Step 2: PRD & Context
run_commit "2/6" \
  "docs(spec): add PRD v1.0 and IT project context baseline" \
  "Add approved PRD v1.0 specification defining DEC-P01 through DEC-P09.
Add GIC 2026 Challenge 4 IT project context v1.1 baseline.
Document reference directory index." \
  "docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md" \
  "references/gic-2026/GIC2026_IT_Project_Context_v1.1.md" \
  "references/README.md"

# Step 3: Guidelines
run_commit "3/6" \
  "docs(guidelines): update AGENTS.md with PRD invariants, IT roles, and design standards" \
  "Enforce non-negotiable business rules: integer-micros ledger (DEC-P02), co-pilot approval gates (DEC-P01), risk-based keyframes (DEC-P03).
Clarify IT1 (Backend/AI/Ledger) and IT2 (Frontend/Media/Reporting) ownership.
Lock demo topology to single-machine localhost with dual LIVE/REPLAY execution modes (DEC-P05).
Reference UI/UX design system in docs/design/." \
  "AGENTS.md"

# Step 4: Design System
run_commit "4/6" \
  "docs(design): add UI/UX design system and 6-stage workstation workflow" \
  "Add PRODUCT.md defining personas, 7 core screens, and cinematic studio craft tone.
Add DESIGN.md establishing dark-mode zinc/obsidian tokens, typographic hierarchy, and anti-slop rules.
Add UI_DESIGN_WORKFLOW.md specifying Three-Pane Workstation layout, status badges, and craft dials." \
  "docs/design/PRODUCT.md" \
  "docs/design/DESIGN.md" \
  "docs/design/UI_DESIGN_WORKFLOW.md"

# Step 5: UI Design Skill
run_commit "5/6" \
  "feat(skills): add ui-design agent skill for workstation authoring" \
  "Introduce reusable agent skill implementing the 6-stage UI design protocol.
Enforce Three-Pane Workstation layout, token compliance, and anti-slop checks." \
  ".agents/skills/ui-design/SKILL.md"

# Step 6: Reference Repositories
run_commit "6/6" \
  "chore(references): add benchmark and design reference repositories" \
  "Add clone references for impeccable, hallmark, and taste-skill design suites.
Used for anti-slop heuristics, typography benchmarks, and craft guidance." \
  "references/hallmark" \
  "references/impeccable" \
  "references/taste-skill"

echo ""
echo "=========================================================="
echo "   Commit process finished successfully!                  "
echo "=========================================================="

if [ "$DRY_RUN" = false ]; then
  git log -n 7 --oneline --graph
fi
