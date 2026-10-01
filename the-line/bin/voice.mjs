// ============================================================================
// The Line — voice bridge (stdio MCP).
//
// Why this exists: a turn spawned by the agent poller is a headless `claude -p`
// subprocess. The task spends a page telling it to call `say` as it works, but
// it cannot reach The Line's HTTP MCP server — that endpoint is OAuth-protected
// and a non-interactive process has no way to run the flow. The result was an
// avatar marked "working" that never made a sound.
//
// So the turn gets THIS instead: a tiny stdio MCP server, which needs no OAuth
// because it is a child process the poller already trusts. It forwards `say`
// and `submit_delta` to the real endpoint using the poller's own token, which
// never enters the turn's environment.
//
// Deliberately NARROW: narration only. The poller submits the final result
// itself, so this exposes no way to finish, fail, or re-queue a task.
// ============================================================================
import { createInterface } from 'node:readline';

// The token comes from the ENVIRONMENT, never argv: argv is world-readable in
// the process table, so `ps aux` on this machine would print it in plaintext.
//
// P3 (option b): argv carries the AGENT, not the task. The task id used to be
// baked in here, which is valid for exactly one turn — fine when every turn
// spawned its own process, fatal once a `claude` child is persistent, because
// every later turn would stamp narration with the FIRST turn's task.
//
// So the bridge asks the server which task is live for its agent, at the moment
// it narrates. The security property is unchanged: the MODEL still never
// supplies a task id.
const [, , BASE, AGENT_ID] = process.argv;
const TOKEN = process.env.LINE_TOKEN ?? '';
/** Device-flow access token, when the parent resolved one (agent.mjs). */
const BEARER = process.env.LINE_BEARER ?? '';

/** Auth header for this bridge's calls.
 *
 *  The bridge runs as a stdio MCP server inside a spawned turn, so it cannot do
 *  the device flow itself — agent.mjs resolves a token and passes it by env.
 *  Bearer when it has one, legacy header otherwise. */
const AUTH = BEARER ? { Authorization: `Bearer ${BEARER}` } : { 'x-line-token': TOKEN };
const MCP = `${BASE.replace(/\/+$/, '')}/agent-mcp`;

let sessionId = null;

/** Which task is this agent on RIGHT NOW?
 *
 *  Asked per tool call rather than cached: a persistent bridge outlives many
 *  turns, and a cached id is exactly the bug this replaces. Cheap — one local
 *  request against a server the poller is already talking to.
 *
 *  Returns null when the agent is between turns, which is a normal answer. The
 *  caller drops the narration instead of guessing at a task. */
async function activeTaskId() {
  try {
    const url = `${BASE.replace(/\/+$/, '')}/api/agent/active-task?agentId=${encodeURIComponent(AGENT_ID)}`;
    const res = await fetch(url, { headers: { ...AUTH } });
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json?.taskId === 'string' ? json.taskId : null;
  } catch {
    // Never throw into a tool call over this: a narration that cannot resolve
    // its task is a dropped line, not a failed turn.
    return null;
  }
}

async function upstream(method, params) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...AUTH,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(MCP, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  try {
    return JSON.parse(line ? line.slice(6) : text);
  } catch {
    return null;
  }
}

async function connect() {
  if (sessionId) return;
  await upstream('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'the-line-voice', version: '0.1.0' },
  });
  await fetch(MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...AUTH,
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
}

// What a TURN may reach. Narration plus the calls that RECORD work — a test
// run, a change moving, an artifact filed. Lucy hit exactly this wall: she ran
// a real suite, reported it on the radio, and said herself that
// "record_test_run and save_artifact aren't connected in this session", so the
// board still read "not tested". Work that can only be spoken is invisible to
// the board and to the auditor.
//
// Still a deliberate ALLOW-LIST, not a passthrough: get_pending_tasks and
// submit_result stay out, because claiming or finishing a task is the poller's
// job. A turn that could settle itself would race its own parent.
const ALLOWED = new Set([
  'say',
  'record_test_run',
  'record_change',
  'list_changes',
  'save_artifact',
  // READING the drawer, not just writing to it. A turn that cannot see what a
  // teammate already filed will redo the work — or, worse, honestly report that
  // no such plan exists when one does.
  'list_artifacts',
  'read_artifact',
  'report_diff',
  'report_project',
  // SHOWING the work, not just filing it. A turn was told to put its report on
  // the canvas and could not — the tools were never exposed here, so the
  // instruction was unfollowable. Same failure as record_change before it.
  'post_to_canvas',
  'set_view',
  // READING the bytes of a file the user dropped onto the composer. The
  // prompt hint ([Attached file: <name> (mime, id=<id>)]) is useless
  // without this — a turn that could be told about a file but could not
  // open it had to ask the user to paste the contents, defeating the drop.
  'read_attachment',
]);

/** The real schemas, fetched upstream, so this bridge never drifts from the
 *  server's own definitions — a hand-copied list would rot the first time a
 *  tool gained a field. */
let toolCache = null;
async function tools() {
  if (toolCache) return toolCache;
  await connect();
  const out = await upstream('tools/list', {});
  const all = out?.result?.tools ?? [];
  toolCache = all.filter((t) => ALLOWED.has(t.name));
  return toolCache;
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

const rl = createInterface({ input: process.stdin });
rl.on('line', async (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'the-line-voice', version: '0.1.0' },
    });
    return;
  }
  if (method === 'notifications/initialized') return;
  if (method === 'tools/list') {
    reply(id, { tools: await tools() });
    return;
  }
  if (method === 'tools/call') {
    const name = String(params?.name ?? '');
    if (!ALLOWED.has(name)) {
      reply(id, { content: [{ type: 'text', text: `No tool named ${name}.` }], isError: true });
      return;
    }
    try {
      await connect();
      // taskId is stamped by the POLLER, never taken from the model: a turn
      // must not be able to narrate into — or record against — someone else's
      // task, even by accident.
      const args = { ...(params?.arguments ?? {}) };
      if (name === 'say') {
        const taskId = await activeTaskId();
        if (!taskId) {
          // Between turns. Saying nothing is correct — the alternative is
          // narrating into a settled task, or someone else's.
          reply(id, { content: [{ type: 'text', text: 'No active task; nothing spoken.' }] });
          return;
        }
        args.taskId = taskId;
      }
      const out = await upstream('tools/call', { name, arguments: args });
      const content = out?.result?.content ?? [{ type: 'text', text: 'Done.' }];
      reply(id, { content, ...(out?.result?.isError ? { isError: true } : {}) });
    } catch (e) {
      reply(id, {
        content: [{ type: 'text', text: `${name} failed: ${e instanceof Error ? e.message : String(e)}` }],
        isError: true,
      });
    }
    return;
  }
  if (id !== undefined) reply(id, {});
});
