#!/usr/bin/env bash
# Fetch updates from upstream for all bare repos in ~/ai/.
# Intended to run as a cron job so the agent always has fresh code to work from.
set -euo pipefail

AI_DIR="${AI_DIR:-$HOME/ai}"
LOG_TAG="sync-bare-repos"

if [[ ! -d "$AI_DIR" ]]; then
  echo "[$LOG_TAG] AI directory not found: $AI_DIR" >&2
  exit 1
fi

shopt -s nullglob
repos=("$AI_DIR"/*.git)

if [[ ${#repos[@]} -eq 0 ]]; then
  echo "[$LOG_TAG] No bare repos found in $AI_DIR"
  exit 0
fi

for repo in "${repos[@]}"; do
  name="$(basename "$repo")"
  if ! git -C "$repo" rev-parse --is-bare-repository &>/dev/null; then
    echo "[$LOG_TAG] Skipping $name (not a bare repo)"
    continue
  fi

  # Only fetch if a remote named 'origin' exists
  if ! git -C "$repo" remote get-url origin &>/dev/null; then
    echo "[$LOG_TAG] Skipping $name (no origin remote)"
    continue
  fi

  # Detect the default branch (main, master, or whatever HEAD points to)
  default_branch="$(git -C "$repo" remote show origin 2>/dev/null | awk '/HEAD branch/ {print $NF}')"
  if [[ -z "$default_branch" ]]; then
    default_branch="main"
  fi

  echo "[$LOG_TAG] Fetching $name ($default_branch)..."
  if git -C "$repo" fetch origin "$default_branch":"$default_branch" 2>&1; then
    echo "[$LOG_TAG] $name up to date"
  else
    echo "[$LOG_TAG] WARNING: fetch failed for $name" >&2
  fi
done
