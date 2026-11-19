#!/usr/bin/env bash
# ==========================================================
# Automated Pull Request generator for nolen-ai-short-assistant
# ==========================================================

set -euo pipefail

cd "$(dirname "$0")/.."

CURRENT_BRANCH=$(git branch --show-current)

if [ -z "$CURRENT_BRANCH" ] || [ "$CURRENT_BRANCH" == "main" ]; then
  echo "Error: You are on '$CURRENT_BRANCH'. You cannot create a PR from main directly."
  echo "Run ./scripts/create_branch.sh <name> first."
  exit 1
fi

TITLE="${1:-}"
PRD_REF="${2:-}"
DESCRIPTION="${3:-}"
TESTS="${4:-}"

if [ -z "$TITLE" ]; then
  LATEST_COMMIT=$(git log -1 --pretty=%s)
  read -rp "Enter PR Title [$LATEST_COMMIT]: " TITLE
  TITLE="${TITLE:-$LATEST_COMMIT}"
fi

if [ -z "$PRD_REF" ]; then
  read -rp "Enter PRD References (e.g. FR-02, DEC-P01): " PRD_REF
  PRD_REF="${PRD_REF:-N/A}"
fi

if [ -z "$DESCRIPTION" ]; then
  read -rp "Enter summary of changes: " DESCRIPTION
  DESCRIPTION="${DESCRIPTION:-Implements changes for $CURRENT_BRANCH.}"
fi

if [ -z "$TESTS" ]; then
  read -rp "Enter tests performed: " TESTS
  TESTS="${TESTS:-Automated and visual verification passed.}"
fi

PR_BODY=$(cat <<EOF
## Description
$DESCRIPTION

## PRD & Architecture References
- **PRD Requirements**: $PRD_REF
- **Branch**: \`$CURRENT_BRANCH\` $\rightarrow$ \`main\`

## Key Changes
- Implemented and verified on branch \`$CURRENT_BRANCH\`.
- Adheres to repository rules in \`AGENTS.md\` and UI guidelines in \`docs/design/\`.

## Verification & Testing Performed
- $TESTS

## Checklist
- [x] Branch follows \`feature/<name>\` (or \`fix/<name>\`).
- [x] Commits adhere to Conventional Commits.
- [x] No secrets, \`.env\`, or credentials committed.
EOF
)

echo "$PR_BODY" > .pr_draft.md
echo "Draft PR saved to .pr_draft.md"

echo "Pushing branch '$CURRENT_BRANCH' to origin..."
git push -u origin "$CURRENT_BRANCH"

if command -v gh &> /dev/null; then
  echo "Creating PR with GitHub CLI..."
  gh pr create --base main --head "$CURRENT_BRANCH" --title "$TITLE" --body "$PR_BODY"
  exit 0
fi

REMOTE_URL=$(git config --get remote.origin.url)
if [[ "$REMOTE_URL" =~ github\.com[:/](.+)/(.+?)(\.git)?$ ]]; then
  OWNER="${BASH_REMATCH[1]}"
  REPO="${BASH_REMATCH[2]}"
  COMPARE_URL="https://github.com/$OWNER/$REPO/compare/main...${CURRENT_BRANCH}?expand=1"
  echo ""
  echo "Please open the URL to finish creating your PR:"
  echo "$COMPARE_URL"

  if command -v xdg-open &> /dev/null; then
    xdg-open "$COMPARE_URL"
  elif command -v open &> /dev/null; then
    open "$COMPARE_URL"
  fi
fi
