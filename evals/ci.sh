#!/usr/bin/env bash
# The ohmigo-evals skill without a person: one headless Claude Code session per
# case and per judge page. Needs `claude` on PATH and a model key. Arguments go
# to serve.mjs (--cases a,b). Exits non-zero unless every case that ran passed.
set -euo pipefail
cd "$(dirname "$0")/.."

log=$(mktemp)
node evals/serve.mjs "$@" > "$log" 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT
until grep -q '^stop with:' "$log"; do
  kill -0 "$server" 2>/dev/null || { cat "$log"; exit 1; }
  sleep 2
done
cat "$log"
run=$(sed -n 's/^READY //p' "$log")

# sessions <agent> <file name> <prompt label>
# A session that dies leaves its case unanswered, which fails the run below.
sessions() {
  find "$PWD/$run" -name "$2" | AGENT=$1 LABEL=$3 xargs -P 4 -I{} sh -c '
    claude -p "$LABEL: $1" --agent "$AGENT" --model haiku --effort low \
      --setting-sources project --strict-mcp-config --permission-mode dontAsk \
      --allowedTools "Bash(node evals/call.mjs:*)" Read Write < /dev/null \
      || echo "session failed: $1"' sh {}
}

sessions ohmigo-eval-assistant brief.md Brief
node evals/grade.mjs "$run" > /dev/null
sessions ohmigo-eval-judge judge.md 'Judge file'
result=$(node evals/grade.mjs "$run")
echo "$result"
grep -Eq '^pass [1-9][0-9]*/[0-9]+, fail 0, pending 0, no answer 0,' <<< "$result"
