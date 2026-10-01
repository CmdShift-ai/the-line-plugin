# Persistent crew agents: stop paying cold-start on every turn

**Status:** spec, from measurements taken 2026-09-28. Not yet built.
**Origin:** Darin — *"resume isn't taking because it's just a shell command it's
not an actual spawned sub agent... I should see 6 subagents attached to this cli
however I don't see any."* He was right about the architecture. One correction
on the mechanism, below.

---

## 1. Measured facts (evidence, 2026-09-28)

| # | Fact | Evidence |
|---|---|---|
| F1 | **Zero crew processes are resident.** One poller (`agent.mjs`), no `claude` children between turns | `ps -ef` during an idle wall |
| F2 | A crew turn spawns `claude -p`, answers, exits | `agent.mjs:585`, `child.on('close')` at 511/732 |
| F3 | **The model is ~20% of the wall time.** opus + Cal's charter, trivial ask: wall 7.5s, `duration_api_ms` 1.7s | CLI's own JSON |
| F4 | It is not process startup: `claude --version` returns in **0.3s** | measured |
| F5 | It is not the model tier: **haiku is as slow as opus** (4.1s wall, 0.8s api) | measured |
| F6 | A cold turn rebuilds **43,453 cache-creation tokens** for a 7-token reply, `cache_read: 0` | CLI usage report |
| F7 | **`--input-format stream-json` keeps one process alive across turns** | probe, below |
| F8 | Persistent, haiku: turn 1 **3,602ms**, turn 2 **686ms**, turn 3 **610ms** | probe |
| F9 | Persistent, opus + charter: turn 1 5,416ms / `cache_new` 26,696 → turn 2 **1,732ms** / `cache_new` **44** | probe |
| F10 | `--resume` recovers the CACHE but still pays startup (~3.5s fixed, flat 50–63KB) | measured 2026-09-27 |

**The correction to Darin's diagnosis:** it is not `--resume` per subagent.
`--resume` spawns a *fresh process* — it fixes cost, not latency. The win comes
from **never exiting**: stdin stays open and the next turn is written into the
same process. Nor are these "subagents" in the Task/Agent sense; they are six
long-lived `claude` children owned by the poller.

**What this is worth:** ~3.3–5.8s per turn. Under one wall lane a six-agent roll
call pays that six times — **20–35s of pure harness cost** before anyone speaks,
which is larger than generation, synthesis, session creation and LiveKit
combined. Cost drops with it: cache creation 26,696 → 44 tokens.

---

## 2. Requirements

### P1: One resident process per crew member
On poller start, spawn six `claude` children — one per agent — each with
`--input-format stream-json --output-format stream-json`, its own charter via
`--append-system-prompt`, and its own MCP config.
- **Test:** after start, `ps` shows six `claude` children of the poller; a roll
  call spawns none.

### P2: Turns route by agentId, and are serialised per child
A task for `cal` is written to cal's stdin. A child handles one turn at a time;
a second task for the same agent queues behind it (the wall lane already
serialises across agents, but the child must not be handed two prompts at once).
- **Test:** two tasks for one agent complete in order, with one `result` each.

### P3: The MCP task id must become per-turn — RESOLVED (option b, `1128b18`)
**This is the blocking design problem.** Today the stdio bridge is spawned with
`job.taskId` baked into its argv (`voice.mjs BASE taskId`), which is only valid
for one turn. A persistent child cannot re-spawn its bridge per task.
- **Darin chose (b), and it is built and deployed.** argv now carries the AGENT;
  the bridge resolves the live task per tool call against
  `GET /api/agent/active-task`, backed by `taskQueue.activeTaskFor(token,
  agentId)`. Verified on prod: no token -> 401, no agentId -> 400, valid token
  on an idle agent -> `{"ok":true,"taskId":null}`.
- The security property is unchanged and is why this resolves server-side rather
  than being passed in: the MODEL never supplies a task id. The request carries
  the poller's own token, and the server answers only with a task that is
  claimed, unsettled, and belongs to that exact (token, agent) pair.
- Resolved PER AGENT, not per token — `sayToActive()` returns any claimed task
  under the token, which was correct when a turn meant one process and wrong
  with six resident agents.
- Rejected (a) as a second protocol to keep in sync, and (c) because it would
  have put the task id in arguments the model controls — the one thing the
  original argv design existed to prevent.
- **Test:** two consecutive turns through one child report `say`/`submit_result`
  against the correct, different task ids.

### P4: A dead child is replaced, not mourned
If a child exits (crash, OOM, upgrade), the poller restarts it and the in-flight
turn fails cleanly rather than hanging until CLAIM_STALL_MS.
- **Test:** kill a child mid-turn → the task settles as crashed within seconds
  and the next task for that agent succeeds on a fresh child.

### P5: Memory is bounded
A process that never exits accumulates a transcript. The spec that governs when
to recycle a child (turn count, resident size, or wall age) must be measured
before it is chosen, not guessed.
- **Test:** RSS and transcript growth recorded over 50 turns; a documented
  recycle threshold with the measurement behind it.

### P6: The HUD tells the truth about the split
`spawned → generated` is currently labelled `claude`, but only ~20% of it is.
Emit `duration_api_ms` (already in the CLI's JSON, currently discarded) so the
timeline separates real model time from harness overhead.
- **Test:** a turn shows both, and their sum is under the observed gap.

---

## 3. Risks, stated plainly

- **This touches the path every crew turn runs through.** A bug here is not a
  degraded face; it is the crew not answering at all.
- ~~P3 has no obvious answer yet.~~ **Settled 2026-09-28 (option b, `1128b18`).**
  P1, P2, P4, P5 and P6 remain.
- Six resident opus processes hold real memory. P5 is not optional.
- Verified on this machine only. The client story (agents on a user's own disk)
  needs its own pass.
