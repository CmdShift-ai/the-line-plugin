#!/usr/bin/env bash
# The Line — restart both pollers on this machine.
#
# Why this exists: the pollers are singletons (one per machine), started either
# by a Claude Code session's plugin monitors or by hand. Picking up new poller
# code (or a changed ~/.the-line/poller.env) means killing the running pair and
# starting fresh ones — which used to mean hunting pids. Now:
#
#   plugin/the-line/bin/restart.sh
#
# Logs land in /tmp/line-agent.log and /tmp/line-poll.log.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

pkill -f 'the-line/bin/agent.mjs' 2>/dev/null && echo "[the-line] stopped agent poller"
pkill -f 'the-line/bin/poll.mjs' 2>/dev/null && echo "[the-line] stopped mechanical poller"
sleep 1

nohup "$HERE/agent.sh" >/tmp/line-agent.log 2>&1 &
nohup "$HERE/poll.sh"  >/tmp/line-poll.log  2>&1 &
sleep 2
echo "[the-line] running:"
pgrep -fl 'the-line/bin/(agent|poll)\.mjs' || echo "  (nothing started — check /tmp/line-agent.log)"
