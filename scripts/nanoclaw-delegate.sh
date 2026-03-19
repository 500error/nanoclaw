#!/usr/bin/env bash
# Delegate a task to NanoClaw by injecting a prompt via IPC.
# NanoClaw picks it up immediately and responds via its configured channel.
# Usage: nanoclaw-delegate.sh "<message>"
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
DB_FILE="$REPO_DIR/store/messages.db"
IPC_MAIN_DIR="$REPO_DIR/data/ipc/slack_main/tasks"

if [[ $# -eq 0 ]]; then
  echo "Usage: nanoclaw-delegate.sh '<message>'" >&2
  exit 1
fi

MESSAGE="$1"

# Resolve main group JID from the NanoClaw database
if [[ ! -f "$DB_FILE" ]]; then
  echo "Error: NanoClaw database not found at $DB_FILE" >&2
  exit 1
fi
MAIN_JID="$(sqlite3 "$DB_FILE" "SELECT jid FROM registered_groups WHERE is_main=1 LIMIT 1;")"
if [[ -z "$MAIN_JID" ]]; then
  echo "Error: No main group registered in NanoClaw database" >&2
  exit 1
fi

# Write a one-shot IPC task — NanoClaw's IPC watcher picks this up and runs it immediately
mkdir -p "$IPC_MAIN_DIR"
TASK_FILE="$IPC_MAIN_DIR/delegate-$(date +%s%N).json"
python3 -c "
import json, sys, datetime
task = {
    'type': 'schedule_task',
    'prompt': sys.argv[1],
    'schedule_type': 'once',
    'schedule_value': datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z'),
    'targetJid': sys.argv[2],
    'context_mode': 'isolated',
}
print(json.dumps(task))
" "$MESSAGE" "$MAIN_JID" > "$TASK_FILE"

echo "Delegated to NanoClaw — response will appear in your main channel"
