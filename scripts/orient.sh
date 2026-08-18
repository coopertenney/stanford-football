#!/usr/bin/env bash
# Orchestrator step 1, in one call. See ORCHESTRATOR-INSTRUCTIONS.md §2.
#
# Exists because orienting by hand cost 8 tool round-trips and ran the gate twice.
# Everything here is read-only. It never commits, never merges, never writes.
set -uo pipefail
cd "$(dirname "$0")/.."

echo "=== REMOTE ==="
git fetch origin 2>&1 || echo "!! fetch FAILED — a silenced fetch is an unobserved fetch"
echo "local  main: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"
echo "origin main: $(git rev-parse --short origin/main 2>/dev/null || echo '(none)')"
behind=$(git rev-list --count HEAD..origin/main 2>/dev/null || echo '?')
echo "unmerged commits on origin/main: $behind"

echo
echo "=== UNCOMMITTED (undeclared work — the board will not show this) ==="
git status --short || true

echo
echo "=== BOARD ==="
python3 scripts/board.py list 2>&1

echo
echo "=== GATE ==="
# One run. The tally line is the baseline to compare against after every dispatch.
gate=$(.venv/bin/python scripts/check.py 2>&1)
echo "$gate" | grep -E "PASS [0-9]+|✗ FAIL|CHANGED" | tail -3
echo "$gate" | grep -E "✗ FAIL|CHANGED" || echo "(no FAIL, no CHANGED)"
echo "full detail: .venv/bin/python scripts/check.py"

echo
echo "=== NEXT ==="
sed -n '/^## 7\./,/^## 8\./p' ORCHESTRATOR-STATE.md | head -12
