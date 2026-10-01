// ============================================================================
// Resident crew agents — one long-lived `claude` process per crew member.
//
// WHY. Every turn used to spawn `claude -p`, answer, and exit. Darin noticed
// the consequence before the code did: "I should see 6 subagents attached to
// this cli however I don't see any."
//
// The cost was measured, not assumed (PERSISTENT-AGENTS-SPEC.md §1):
//
//   opus + Cal's charter, trivial ask:  wall 7.5s,  duration_api_ms 1.7s
//
// So ~5.8s of every turn was harness rather than model. It is not process
// startup (`claude --version` returns in 0.3s) and not the model tier (haiku is
// just as slow as opus). It is the per-call assembly: 43,453 cache-creation
// tokens rebuilt for a 7-token reply, with cache_read at 0.
//
// Keeping the process alive fixes both halves at once:
//
//   turn 1  5,416ms  cache_new 26,696
//   turn 2  1,732ms  cache_new      44
//
// `--resume` does NOT do this. It restores the cache but still pays the spawn,
// which is the larger cost.
//
// WHAT HAD TO LAND FIRST. The stdio MCP bridge took `job.taskId` in its argv,
// valid for exactly one turn. A child that serves many turns would have stamped
// every later narration with the first turn's task. P3 (1128b18) moved that to
// a per-call lookup keyed by AGENT, which is why this file passes an agent id.
// ============================================================================
import { spawn } from 'node:child_process';

/** How long a single turn may run before we give up on the child.
 *
 *  Under the server's one wall lane a stuck child blocks the crew, and the
 *  server settles a claimed-but-silent task at CLAIM_STALL_MS (120s). Staying
 *  under that means the poller reports a real failure rather than the queue
 *  timing out around it. */
const TURN_TIMEOUT_MS = 100_000;

/** Children die — upgrades, OOM, a vendor hiccup. A resident pool makes that a
 *  recoverable event instead of an agent that is silent for the rest of the
 *  session, so the next turn simply spawns a fresh one. */
export class AgentPool {
  constructor({ base, model, mcpPath, cwd, env }) {
    this.base = base;
    this.model = model;
    this.mcpPath = mcpPath;
    this.cwd = cwd;
    this.env = env;
    /** agentId -> { child, buf, busy, onResult, onErr, timer, systemGuidance } */
    this.children = new Map();
  }

  /** Start (or restart) one agent's child. Idempotent. */
  spawnChild(agentId, systemGuidance) {
    const prev = this.children.get(agentId);
    if (prev?.child && !prev.child.killed) return prev;

    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', this.model,
      // The charter is fixed for the life of the child. That is the point: it
      // is what gets cached, and re-sending it per turn is the cost being
      // removed here.
      ...(systemGuidance ? ['--append-system-prompt', systemGuidance] : []),
      // P3: the bridge receives the AGENT, and resolves the live task per tool
      // call. A task id here would be wrong on every turn after the first.
      '--mcp-config', JSON.stringify({
        mcpServers: {
          'the-line': {
            type: 'stdio',
            command: process.execPath,
            args: [this.mcpPath, this.base, agentId],
          },
        },
      }),
      '--strict-mcp-config',
    ];

    const child = spawn('claude', args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });

    const entry = { child, buf: '', busy: false, onResult: null, onErr: null, timer: null, systemGuidance };
    this.children.set(agentId, entry);

    child.stdout.on('data', (d) => this.#consume(agentId, entry, d));

    const die = (why) => {
      // Fail the turn in flight LOUDLY. Silence here is the worst outcome: the
      // server would hold the wall lane until CLAIM_STALL_MS with no reason
      // recorded anywhere.
      if (entry.busy && entry.onErr) {
        const fail = entry.onErr;
        entry.busy = false;
        entry.onResult = entry.onErr = null;
        if (entry.timer) clearTimeout(entry.timer);
        fail(new Error(`agent child for ${agentId} ${why}`));
      }
      this.children.delete(agentId);
    };
    child.on('exit', (code, sig) => {
      console.warn(`[pool] ${agentId} child exited code=${code} sig=${sig} — will respawn on next turn`);
      die(`exited (code=${code} sig=${sig})`);
    });
    child.on('error', (err) => {
      console.warn(`[pool] ${agentId} child error:`, err?.message ?? err);
      die(`errored: ${err?.message ?? err}`);
    });

    console.log(`[pool] ${agentId} resident child up (pid ${child.pid})`);
    return entry;
  }

  /** Parse NDJSON from the child and settle the turn on its `result`. */
  #consume(agentId, entry, chunk) {
    entry.buf += chunk;
    let i;
    while ((i = entry.buf.indexOf('\n')) >= 0) {
      const line = entry.buf.slice(0, i);
      entry.buf = entry.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // partial or non-JSON noise; the next newline will resync
      }
      if (msg.type !== 'result') continue;
      const done = entry.onResult;
      entry.busy = false;
      entry.onResult = entry.onErr = null;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (done) done(msg);
    }
  }

  /** Run one turn on this agent's resident child.
   *
   *  ONE AT A TIME. Two prompts written into one stdin would interleave two
   *  conversations in a single session — the child has no notion of concurrent
   *  turns. The server's wall lane already serialises across agents; this
   *  guards the per-agent case (a handoff arriving while the agent is mid-turn).
   */
  ask(agentId, prompt, systemGuidance) {
    const entry = this.spawnChild(agentId, systemGuidance);
    if (entry.busy) {
      return Promise.reject(new Error(`agent ${agentId} is already mid-turn`));
    }
    return new Promise((resolve, reject) => {
      entry.busy = true;
      entry.onResult = resolve;
      entry.onErr = reject;
      entry.timer = setTimeout(() => {
        // Kill it: a child stuck mid-turn cannot be trusted to take the next
        // one, and respawning is cheap compared to a wedged agent.
        console.warn(`[pool] ${agentId} turn exceeded ${TURN_TIMEOUT_MS}ms — killing the child`);
        try {
          entry.child.kill('SIGKILL');
        } catch {
          /* already gone; the exit handler settles the turn */
        }
      }, TURN_TIMEOUT_MS);
      try {
        entry.child.stdin.write(
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: prompt }] },
          }) + '\n',
        );
      } catch (err) {
        entry.busy = false;
        entry.onResult = entry.onErr = null;
        clearTimeout(entry.timer);
        reject(err);
      }
    });
  }

  /** Warm every agent at start, so the first real turn is not a cold one. */
  warm(agentIds, guidanceFor) {
    for (const id of agentIds) {
      try {
        this.spawnChild(id, guidanceFor(id));
      } catch (err) {
        console.warn(`[pool] could not warm ${id}:`, err?.message ?? err);
      }
    }
  }

  shutdown() {
    for (const [, e] of this.children) {
      try {
        e.child.kill();
      } catch {
        /* best effort */
      }
    }
    this.children.clear();
  }
}
