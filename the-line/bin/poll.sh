#!/usr/bin/env bash
# ============================================================================
# The Line — background poller.
#
# Why this exists: Claude Code has ONE conversation thread. The crew's work
# queue is drained by calling get_pending_tasks, so the moment the main thread
# starts a long task, nobody is polling — the connection light flips to SERVER
# and mechanical work (folder listings, file reads, diffs) stalls behind
# whatever the model happens to be doing.
#
# A plugin monitor runs as a SEPARATE PROCESS for the session's lifetime, so it
# can poll continuously without occupying the thread. It deliberately takes
# MECHANICAL work only (execOnly): an agent turn needs a conversation someone is
# actually reading, and this has none.
#
# Note: CLAUDE_PLUGIN_ROOT is NOT set inside a monitor process (it is only
# interpolated into the command string), so paths here resolve from $0.
# ============================================================================
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${HOME}/.the-line/poller.env"

# Config lives outside the plugin so an upgrade cannot clobber it, and so the
# token is never committed alongside the code.
if [ -f "$CONFIG" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG"
fi

LINE_URL="${LINE_URL:-https://line.cmdshift.ai}"
LINE_TOKEN="${LINE_TOKEN:-}"
WORKER_ID="${LINE_WORKER_ID:-plugin-$$}"

# NO TOKEN GATE. This used to exit here when LINE_TOKEN was empty, which is why
# installing the plugin on a clean machine produced a monitor that started,
# found nothing, and stopped — with the only instructions in a file nobody was
# ever told to create.
#
# The poller now authenticates itself: deviceAuth.mjs runs the RFC 8628 device
# flow, prints a short code, and waits for the person to approve it in a browser
# they already have open. LINE_TOKEN is still honoured as a fallback for
# machines connected before that existed.

if ! command -v node >/dev/null 2>&1; then
  echo "[the-line] node not found on PATH; the poller needs it."
  exit 0
fi

# One poller per machine, not per session. Every session's monitor starts this
# script; without a guard they all poll the same queue and race for the same
# work. Checked last, so a session missing node or a token never holds the lock.
# shellcheck disable=SC1090
. "${HERE}/singleton.sh"
line_singleton "poll" || exit 0

# Token by ENVIRONMENT, not argv: an argument is world-readable in the
# process table, so `ps aux` would print it in plaintext to anything
# running on this machine.
export LINE_TOKEN
exec node "${HERE}/poll.mjs" "$LINE_URL" "$WORKER_ID"
