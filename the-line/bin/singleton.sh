#!/usr/bin/env bash
# ============================================================================
# The Line — single-instance guard for the pollers.
#
# Why this exists: both pollers are declared as plugin monitors with
# "when": "always", so EVERY Claude Code session that loads the plugin spawns
# its own pair. Two sessions meant four processes, all polling the same account
# with the same token but distinct PID-derived worker ids.
#
# The server hands a queued turn to whichever worker polls first. With more than
# one agent poller that is a race, and the loser is silent: a turn claimed by an
# instance that is not the one doing the work simply never produces a reply.
# That is how a hail times out at 60s with "No reply from Cal" while a perfectly
# healthy poller sits alongside it.
#
# So: first session to start wins and runs the only poller. Later sessions find
# the lock held and exit 0 quietly — a monitor that no-ops is correct here, not
# an error. Nothing is killed; the extra monitors simply decline to duplicate.
#
# Self-healing matters more than elegance. If the holder dies (session closed,
# crash, SIGKILL), the lock must not wedge the feature until someone notices, so
# a lock naming a PID that is gone is taken over rather than respected.
#
# mkdir, not flock: flock(1) is not present on macOS by default, and this runs
# on the developer's laptop. `mkdir` is atomic on every POSIX filesystem, which
# is the only property the guard actually needs.
# ============================================================================

# Usage: line_singleton <name>   — call AFTER preflight checks, BEFORE exec.
# Holding a lock while node is missing would block a session that could run.
line_singleton() {
  local name="$1"
  local dir="${HOME}/.the-line/locks/${name}.lock"
  local pidfile="${dir}/pid"

  mkdir -p "${HOME}/.the-line/locks" 2>/dev/null || return 0

  # Retry once: the only expected failure is a stale lock, which the check
  # below clears. A second failure means a live holder, so stand down.
  local tries=2
  while [ "$tries" -gt 0 ]; do
    tries=$((tries - 1))
    if mkdir "$dir" 2>/dev/null; then
      printf '%s' "$$" > "$pidfile" 2>/dev/null
      # Release on exit so a clean shutdown frees the slot immediately rather
      # than leaving the next session to time out on staleness.
      # shellcheck disable=SC2064
      trap "rm -rf '$dir'" EXIT INT TERM
      return 0
    fi

    local holder
    holder="$(cat "$pidfile" 2>/dev/null || true)"

    # A held lock whose PID is still alive is the normal case: another session
    # is already running this poller and we are the duplicate.
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      echo "[the-line] ${name} already running (pid ${holder}) — this session defers to it."
      return 1
    fi

    # Stale: the holder is gone, or the directory exists with no readable pid
    # (a process killed between mkdir and the write). Reclaim and retry.
    rm -rf "$dir" 2>/dev/null
  done

  # Lost both races to another starting session. Deferring is still correct.
  echo "[the-line] ${name} claimed by another session — this one defers."
  return 1
}
