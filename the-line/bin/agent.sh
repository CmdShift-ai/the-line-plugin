#!/usr/bin/env bash
# The Line — agent poller. Sibling to poll.sh: that one drains mechanical work,
# this one also takes agent turns and runs them through the local `claude` CLI,
# so a turn executes on THIS machine against the real project.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${HOME}/.the-line/poller.env"
if [ -f "$CONFIG" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG"
fi

LINE_URL="${LINE_URL:-https://line.cmdshift.ai}"
LINE_TOKEN="${LINE_TOKEN:-}"
WORKER_ID="${LINE_AGENT_WORKER_ID:-agent-$$}"

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
  echo "[the-line] node not found on PATH; the agent poller needs it."
  exit 0
fi
# The turn engine. Without it this poller could claim turns it cannot run,
# which is worse than not claiming them — the work would vanish.
if ! command -v claude >/dev/null 2>&1; then
  echo "[the-line] claude CLI not found on PATH; agent turns need it."
  exit 0
fi

# One agent poller per machine, not per session. This guard matters more here
# than for the mechanical poller: a duplicate can CLAIM a turn and then fail to
# produce a reply, so the work vanishes and the hail times out at 60s looking
# like the agent is broken. Checked after the claude/node preflight, so a
# session that cannot run turns never takes the lock from one that can.
# shellcheck disable=SC1090
. "${HERE}/singleton.sh"
line_singleton "agent" || exit 0

# Token by ENVIRONMENT, not argv: an argument is world-readable in the
# process table, so `ps aux` would print it in plaintext to anything
# running on this machine.
export LINE_TOKEN
# WHICH CONVERSATION `@the-line` INHERITS. Sourced from poller.env above but
# only reaches the child if exported. Unset is fine: direct prompts then run
# without the conversation rather than failing.
export LINE_SEED_SESSION
export LINE_TURN_MODEL
# P1: keep six `claude` processes resident rather than spawning one per turn.
# Sourced vars are NOT inherited by the node child unless exported — every other
# setting here is exported for the same reason, and forgetting it would leave
# the flag silently off while poller.env said it was on.
RESIDENT_AGENTS="${RESIDENT_AGENTS:-0}"
export RESIDENT_AGENTS
# THE CHARTERS CURL THE SERVER. Gate resolution, view switching and the canvas
# screen stream are HTTP endpoints, not MCP tools, and every charter documents
# them as `curl "$LINE_URL/api/..." -H "authorization: Bearer
# $LINE_SERVICE_TOKEN"`. Neither variable was exported, so those calls went out
# with an empty token to an address that did not exist — the agent then
# reported the CAPABILITY as missing, which is a different problem with a
# different fix.
export LINE_URL
export LINE_SERVICE_TOKEN
exec node "${HERE}/agent.mjs" "$LINE_URL" "$WORKER_ID"
