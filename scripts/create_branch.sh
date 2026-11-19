#!/usr/bin/env bash
# ==========================================================
# Git Branch Creator for nolen-ai-short-assistant
# Enforces 'feature/<name>' convention
# ==========================================================

set -euo pipefail

cd "$(dirname "$0")/.."

NAME="${1:-}"
TYPE="${2:-feature}"
FROM_CURRENT="${3:-false}"

if [ -z "$NAME" ]; then
  read -rp "Enter branch name (e.g. storyboard-workspace): " NAME
  if [ -z "$NAME" ]; then
    echo "Branch name cannot be empty. Aborted."
    exit 1
  fi
fi

# Clean and normalize
CLEAN_NAME=$(echo "$NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | sed -E 's/[^a-z0-9\-_/]//g')

# Strip prefix if already typed
for prefix in feature feat fix chore docs refactor test; do
  if [[ "$CLEAN_NAME" =~ ^$prefix/(.+)$ ]]; then
    CLEAN_NAME="${BASH_REMATCH[1]}"
    if [ "$prefix" == "feat" ]; then TYPE="feature"; else TYPE="$prefix"; fi
    break
  fi
done

BRANCH_NAME="$TYPE/$CLEAN_NAME"

echo "Target Branch: $BRANCH_NAME"

if git show-ref --verify --quiet "refs/heads/$BRANCH_NAME"; then
  echo "Branch '$BRANCH_NAME' already exists."
  read -rp "Switch to it? (y/n): " SWITCH_NOW
  if [[ "$SWITCH_NOW" =~ ^[Yy]$ ]]; then
    git switch "$BRANCH_NAME"
  fi
  exit 0
fi

if [ "$FROM_CURRENT" != "true" ]; then
  git checkout main 2>/dev/null || true
  git pull --rebase origin main 2>/dev/null || true
fi

git switch -c "$BRANCH_NAME"
echo "Successfully created and checked out: $BRANCH_NAME"
