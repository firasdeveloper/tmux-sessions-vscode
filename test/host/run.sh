#!/bin/sh
# Runs the smoke test in a real VS Code with a throwaway profile and a throwaway tmux server. Needs `code` and `tmux` on PATH.
# A VS Code window opens for a few seconds and closes by itself.
set -u
here="$(cd "$(dirname "$0")/../.." && pwd)"; tmp="$(mktemp -d)"; sock="tsv-smoke-$$"
trap 'tmux -L "$sock" kill-server 2>/dev/null; rm -rf "$tmp"' EXIT
tmux -L "$sock" new-session -d -s smoke -c "$tmp" || exit 1
TSV_SOCK="$sock" TSV_RESULT="$tmp/result" code --new-window --wait --disable-workspace-trust --user-data-dir "$tmp/user" --extensions-dir "$tmp/ext" \
  --extensionDevelopmentPath="$here" --extensionTestsPath="$here/test/host" "$tmp" >/dev/null 2>&1 &
i=0; while [ ! -s "$tmp/result" ] && [ "$i" -lt 90 ]; do sleep 1; i=$((i + 1)); done
cat "$tmp/result" 2>/dev/null || echo "FAIL no result after 90 s"
grep -q '^PASS' "$tmp/result" 2>/dev/null
