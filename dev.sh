#!/usr/bin/env bash
# Boot the whole dev stack: local Convex backend + Vite web app.
set -euo pipefail
cd "$(dirname "$0")"

SESSION=mail-dev

if ! command -v tmux >/dev/null; then
  echo "tmux required" >&2
  exit 1
fi

tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new -d -s "$SESSION" -n convex
tmux send-keys -t "$SESSION:convex" "cd packages/convex && npx convex dev" Enter
tmux new-window -t "$SESSION" -n web
tmux send-keys -t "$SESSION:web" "cd packages/web && bun run dev" Enter

echo "dev stack running in tmux session '$SESSION'"
echo "  web:    http://localhost:3300"
echo "  attach: tmux attach -t $SESSION"
