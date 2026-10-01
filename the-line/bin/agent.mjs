// ============================================================================
// The Line — agent poller (the crew's voice).
//
// Sibling to poll.mjs. That one takes MECHANICAL work (listings, reads, diffs)
// and does it inline. This one takes AGENT TURNS — someone talking to Cal —
// and runs them through the local `claude` CLI, so the turn executes on THIS
// machine with real tools against the real project.
//
// Why it must exist: the crew only answers while something calls
// get_pending_tasks. Claude Code has one conversation thread, so the moment it
// is busy the queue stalls and the wall goes silent. When that happens the
// server falls back to its own box — which holds none of the user's files, so
// the agent answers about the wrong disk or not at all.
//
// It also takes exec work. A poller that could only do turns would sit idle
// between them while listings queued behind a busy sibling; both pollers being
// able to do both means whoever is free takes the next thing.
// ============================================================================
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { AgentPool } from './agentPool.mjs';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
import { getAccessToken } from './deviceAuth.mjs';
const [, , BASE, WORKER_ID] = process.argv;
// LEGACY FALLBACK, kept for one release. A machine connected before the device
// flow still has LINE_TOKEN in ~/.the-line/poller.env; cutting it off in the
// same change that introduces the replacement would stop every working poller
// until its owner noticed.
const TOKEN = process.env.LINE_TOKEN ?? '';

/** Auth for an MCP request: OAuth device-flow token first, legacy header second.
 *  See deviceAuth.mjs for why these processes cannot use the normal code flow. */
async function authHeaders() {
  try {
    const token = await getAccessToken(BASE, (line) => console.log(line));
    return { Authorization: `Bearer ${token}` };
  } catch (err) {
    if (TOKEN) {
      console.warn(`[the-line] device auth unavailable (${err.message}) — using LINE_TOKEN`);
      return { 'x-line-token': TOKEN };
    }
    throw err;
  }
}
const MCP = `${BASE.replace(/\/+$/, '')}/agent-mcp`;

// A turn gets a real budget: the crew does actual work (reads the repo, runs
// git), and killing it early would look exactly like the silence this fixes.
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
// WHICH MODEL RUNS A CREW TURN.
//
// History, because the default has now been wrong in both directions:
//
// Originally there was no flag, so every turn inherited the machine's default
// — which had become Fable with the 1M-context beta, the most expensive
// configuration available, silently applied to six agents whose sessions
// replay their ENTIRE history on every --resume. Measured: ~$80 in 30 minutes
// of roll-call testing. The fix (d71cf4d) pinned Sonnet.
//
// That over-corrected. The crew had been running on OPUS before Fable, and
// that is the behaviour the product was demonstrated with. Pinning Sonnet
// changed how the charters are READ, not just what they cost: asked to open a
// browser — something Cal has Bash for and had done repeatedly on video — he
// declined it as outside his lane and explained his job instead. Nothing about
// tools, charters or permissions had changed that day; only the model reading
// them. A charter is a prompt, and a cheaper reader interprets its scope more
// literally.
//
// So: Opus. It is the model the crew was built and demoed against. The cost
// lesson from the Fable incident still stands and is unaddressed — the
// --resume replay grows without bound — but the answer to that is bounding the
// replay, not paying for it with the crew's judgement.
//
// Override per machine with LINE_TURN_MODEL in ~/.the-line/poller.env.
const TURN_MODEL = process.env.LINE_TURN_MODEL || 'opus';

// ---- @the-line context -----------------------------------------------------
// WHICH CONVERSATION `@the-line` ANSWERS FROM.
//
// A direct prompt used to run as a bare `claude -p`: a stranger with the user's
// tools and none of their conversation, which is why the answers read as
// context-free. The fix is one flag.
//
//   claude -p --resume <id> --fork-session
//
// `--fork-session` replays that transcript into a NEW session id. That last
// part is what makes it safe: plain `--resume` would put a second writer on a
// transcript the live session is still appending to, which is the exact hazard
// this file already documents for crew turns ("two concurrent turns for one
// agent would interleave writes into that session and corrupt its memory").
// A fork reads the history and writes somewhere else.
//
// TWO-STAGE, because the replay is not free. Forking a long thread costs real
// money — measured at $2.83 for a single prompt against a 3.7MB transcript,
// the same mechanism behind the $80/30min this file's TURN_MODEL comment
// records. So the fork happens ONCE: the first prompt pays to inherit the
// conversation, and every prompt after resumes the FORK, which starts small and
// grows only with @the-line's own traffic.
//
// LINE_SEED_SESSION in ~/.the-line/poller.env names the session to inherit
// from. Unset → no seed, and direct prompts run as they did before: still
// answered, just without the conversation. That degradation is deliberate —
// nothing about @the-line should require a particular session to exist.
const SEED_SESSION = process.env.LINE_SEED_SESSION || '';
// The forked session, once we have one. Held for the life of this poller; a
// restart re-seeds from SEED_SESSION rather than resuming a fork whose id we
// have forgotten.
let directSession = null;

// SURVIVE A BAD CALLBACK. A throw inside a child-process event handler is
// uncaught, and Node's default is to kill the process — so one bad line took
// the whole poller down mid-turn, leaving the card reading "working" forever
// with nothing alive to settle it. From the wall that is indistinguishable
// from a slow agent, which is the worst possible failure mode: it looks like
// patience is the answer.
//
// Logging and continuing is right here, NOT because the error is unimportant
// but because the poller is the only thing that can settle in-flight work. A
// crashed poller strands every turn it was holding; a logged one strands the
// turn that threw. The server's claim-stall timer is the backstop for that
// single turn.
process.on('uncaughtException', (e) => {
  console.error(`[the-line] uncaught: ${e?.stack || e}`);
});
process.on('unhandledRejection', (e) => {
  console.error(`[the-line] unhandled rejection: ${e?.stack || e}`);
});

let sessionId = null;

// ---- work liveness ---------------------------------------------------------
// The server cannot see whether an agent is working. Turns run HERE, on this
// machine, and the server only relays them — so it showed a card as
// "building · cal · 11h 56m" with no way to know the turn had already died.
// (Checked at the time: `pgrep -P <this pid>` returned zero children.)
//
// This process is the one thing that knows. It already polls the server, so the
// report rides the poll it was making anyway: `working` is the set of agent ids
// with a turn in flight right now.
const working = new Set();

// CONCURRENT TURNS, ONE PER AGENT.
//
// The loop used to `await handle(parts)`, so this process ran exactly one turn
// at a time: the next poll did not even happen until the current `claude`
// subprocess exited. With turns running 60-107s, a six-way roll call was six
// sequential subprocesses and the wall sat silent between speakers — most of the
// wait was GENERATION, not talking.
//
// Speech must stay strictly serial (one voice, in order — that is the product).
// Generation need not be. The server already supports this: claim() hands out one
// task per call and returns immediately, `working` is already a Set keyed by
// agent, and beginWork/endWork is already finally-safe. The piece that forced
// serialisation was this client's `await`.
//
// THE LIMIT THAT MATTERS: one turn per AGENT, never two. Each agent resumes its
// OWN Claude session via `--resume <sessionId>`, so two concurrent turns for the
// same agent would interleave writes into one session and corrupt its memory.
// Different agents resume different sessions and are safe.
//
// Safe only because the server now holds the speaking floor until the room is
// actually quiet (5f27239). Before that, concurrent turns meant concurrent
// SPEECH — which is the failure this file's own comments describe: "with several
// agents working the crew talked over each other".
const turnsInFlight = new Map(); // agentId -> Promise
const MAX_CONCURRENT_TURNS = 4;
/** Pause after declining queued work, so a full slate does not spin the poll.
 *  Raced against the in-flight turns, so a freed slot is claimed at once. */
const DECLINE_PAUSE_MS = 2_000;

// A turn is AWAITED in loop(), so for up to 10 minutes this process makes no
// poll at all — and the server's report would expire exactly during the long
// turn it most needs to describe, flipping a genuinely busy agent to "unknown".
// So while any turn is in flight, keep reporting on a timer. Well inside the
// server's freshness window, and cheap: the only real payload is the list.
//
// It polls as a SEPARATE execOnly worker id so it can never be handed an agent
// turn — this timer fires while the main loop is already busy with one, and a
// second turn arriving here would have nothing to run it.
const LIVENESS_MS = 20_000;
let livenessTimer = null;

function reportWorking() {
  void rpc('tools/call', {
    name: 'get_pending_tasks',
    arguments: { workerId: `${WORKER_ID}-liveness`, execOnly: true, working: [...working] },
  }).catch(() => undefined);
}

/** Mark a turn in flight and keep the server told until it finishes. Returns the
 *  matching finish function; call it in a `finally` so a throw cannot leave an
 *  agent pinned as busy on this side. The server expires the report anyway, but
 *  that expiry is a backstop for a DEAD loop — not a licence for a live one to
 *  keep reporting something it knows is over. */
function beginWork(agentId) {
  if (agentId) working.add(agentId);
  reportWorking();
  if (!livenessTimer) {
    livenessTimer = setInterval(reportWorking, LIVENESS_MS);
    // Never hold the process open for the sake of the heartbeat.
    if (livenessTimer.unref) livenessTimer.unref();
  }
  return () => {
    if (agentId) working.delete(agentId);
    if (working.size === 0 && livenessTimer) {
      clearInterval(livenessTimer);
      livenessTimer = null;
    }
    // Report the DROP immediately rather than waiting for the next main-loop
    // poll. A finished turn that still reads as working for 25s is the small
    // version of the same lie.
    reportWorking();
  };
}

/** Fire-and-forget lifecycle marks for the developer HUD.
 *
 *  Diagnostics must never be able to break or slow a turn, so this never
 *  awaits and never throws: a HUD that costs a reply is worse than no HUD.
 *  The server ignores marks for unknown taskIds. */
function reportMarks(taskId, marks) {
  if (!taskId || !marks.length) return;
  void rpc('tools/call', {
    name: 'report_marks',
    arguments: { taskId, marks },
  }).catch(() => undefined);
}

async function rpc(method, params) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(await authHeaders()),
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(MCP, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e9), method, params }),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const body = line ? line.slice(6) : text;
  if (!body.trim()) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function handshake() {
  sessionId = null;
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'the-line-agent', version: '0.1.0' },
  });
  if (!init || init.error) return false;
  await fetch(MCP, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(await authHeaders()),
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return true;
}

// ---- mechanical ops (shared shape with poll.mjs) ---------------------------
const MAX_FILE_BYTES = 600 * 1024;
const MAX_BINARY_BYTES = 20 * 1024 * 1024;
const MAX_PATCH_LINES = 4000;
const VIEWABLE_BINARY = new Map(Object.entries({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
  ogv: 'video/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac', pdf: 'application/pdf',
}));

function resolveInRoot(root, rel) {
  const full = path.resolve(root, rel || '');
  const base = path.resolve(root);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

async function doListDir(spec) {
  const dir = resolveInRoot(spec.root, spec.path);
  if (!dir) return { error: 'path escapes the project root' };
  const items = await readdir(dir, { withFileTypes: true });
  return {
    entries: items
      .filter((d) => d.name !== '.git' && d.name !== 'node_modules')
      .map((d) => ({ name: d.name, dir: d.isDirectory() })),
  };
}

async function doReadFile(spec) {
  const file = resolveInRoot(spec.root, spec.path);
  if (!file) return { error: 'path escapes the project root' };
  const st = await stat(file);
  if (!st.isFile()) return { error: 'not a file' };
  const dot = file.lastIndexOf('.');
  const ext = dot === -1 ? '' : file.slice(dot + 1).toLowerCase();
  const mediaType = VIEWABLE_BINARY.get(ext);
  if (mediaType) {
    if (st.size > MAX_BINARY_BYTES) {
      return { skipped: true, reason: `${Math.round(st.size / (1024 * 1024))}MB — too large to load` };
    }
    return { binary: (await readFile(file)).toString('base64'), mediaType };
  }
  if (st.size > MAX_FILE_BYTES) {
    return { skipped: true, reason: `${Math.round(st.size / 1024)}KB — too large to display` };
  }
  const buf = await readFile(file);
  if (buf.subarray(0, 8000).includes(0)) {
    return { skipped: true, reason: `binary file (.${ext || 'unknown'})` };
  }
  return { content: buf.toString('utf8') };
}

async function doDiff(spec) {
  const root = path.resolve(spec.root);
  const base = spec.baseBranch || 'main';
  const branch = spec.branch || '';
  if (!branch) return { error: 'no branch given' };
  const git = (args) => run('git', args, { cwd: root, maxBuffer: 1024 * 1024 * 256 });
  const { stdout: numstat } = await git(['diff', `${base}...${branch}`, '--numstat']);
  const { stdout: all } = await git(['diff', `${base}...${branch}`]);
  const patches = [];
  let curPath = null;
  let buf = [];
  const flush = () => {
    if (curPath === null) return;
    if (buf.length <= MAX_PATCH_LINES) patches.push({ path: curPath, patch: buf.join('\n') });
    buf = [];
  };
  for (const line of all.split('\n')) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) { flush(); curPath = m[2]; }
    if (curPath !== null) buf.push(line);
  }
  flush();
  return { numstat, patches };
}

// ---- direct CLI runs (`@the-line <prompt>`) -------------------------------
//
// Peer to runTurn but stripped down: no `--mcp-config` (no voice bridge — the
// reply streams back via submit_result instead of `say`), no
// `--append-system-prompt`, no `--resume`. The prompt runs as a one-shot
// `claude -p` against this machine's full tool set so the user gets the same
// environment their terminal does.
/** Fetch a dropped attachment to a local file so `claude -p` can Read it.
 *
 *  The crew path hands an agent `mcp__the-line__read_attachment`. A direct run
 *  spawns WITHOUT --mcp-config and has no such tool, so the bytes have to land
 *  on disk instead. Returns the path, or null — a failed download must degrade
 *  to answering without the file, never lose the prompt. */
async function fetchAttachment(att) {
  if (!att?.id) return null;
  try {
    // AUTH: the SERVICE token, not the poller's LINE_TOKEN. The route resolves
    // a user principal and checks ownership structurally — the storage path
    // must begin with the caller's user id — and only the service token maps
    // to the owner that way. Sending LINE_TOKEN here 401s.
    const svc = process.env.LINE_SERVICE_TOKEN || '';
    if (!svc) {
      console.log('[the-line] attachment skipped — LINE_SERVICE_TOKEN not set');
      return null;
    }
    const res = await fetch(`${BASE.replace(/\/+$/, '')}/api/attachment/${encodeURIComponent(att.id)}`, {
      headers: { authorization: `Bearer ${svc}` },
    });
    if (!res.ok) {
      console.log(`[the-line] attachment ${att.id.slice(0, 8)} fetch failed (${res.status})`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    // Keep the original basename — it is what the user will refer to — but
    // strip any path separators so a crafted filename cannot escape the temp
    // directory. The id prefix keeps two files of the same name apart.
    const safe = String(att.name || 'file').replace(/[/\\]/g, '_').slice(0, 80);
    const dir = path.join(os.tmpdir(), 'the-line-attachments');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${att.id.slice(0, 8)}__${safe}`);
    await writeFile(file, buf);
    console.log(`[the-line] attachment -> ${file} (${buf.length}b)`);
    return file;
  } catch (e) {
    console.log(`[the-line] attachment fetch error: ${e?.message ?? e}`);
    return null;
  }
}

/** P1: keep six `claude` processes resident instead of spawning one per turn.
 *  Opt-in while it earns trust — this is the path every crew turn takes. */
const RESIDENT_AGENTS = process.env.RESIDENT_AGENTS === '1';

const pool = new AgentPool({
  base: BASE,
  model: TURN_MODEL,
  mcpPath: new URL('./voice.mjs', import.meta.url).pathname,
  cwd: process.cwd(),
  env: process.env,
});

// A resident child outlives the turn but not the poller. Without this they
// survive as orphans holding a subscription seat.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    pool.shutdown();
    process.exit(0);
  });
}

function runDirect(job) {
  return new Promise((resolve) => {
    // THREE STATES, in order of preference:
    //   1. we already forked -> resume the fork (cheap, accumulating memory)
    //   2. a seed is configured -> fork it ONCE to inherit the conversation
    //   3. neither -> a bare one-shot, exactly as before
    const resumeArgs = directSession
      ? ['--resume', directSession]
      : SEED_SESSION
        ? ['--resume', SEED_SESSION, '--fork-session']
        : [];
    const args = [
      '-p', job.prompt,
      '--model', TURN_MODEL,
      // STREAM IT. `--output-format json` buffers the whole reply and prints it
      // once at exit, so the wall showed a spinner for the entire run and then
      // the answer arrived in one block — on a forked session that replays a
      // large transcript, that is a long silence with nothing to read.
      // stream-json emits NDJSON as the model produces text, and
      // --include-partial-messages makes it per-chunk rather than per-message.
      // Nothing new is needed server-side: pushDelta -> the direct task's
      // onDelta -> a `the-line` bubble is already the path crew replies use.
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      ...resumeArgs,
      // THE LIVE SESSION'S BRIEF. A direct run is a stranger by construction —
      // no --resume, no charter — which is exactly why `@the-line` answers read
      // as context-free. When a session has pushed a brief (set_context), the
      // server puts it on the task and it rides in here, so the one-shot knows
      // what is being built without the session having to be awake to answer.
      ...(job.systemGuidance ? ['--append-system-prompt', job.systemGuidance] : []),
      // No `--strict-mcp-config` either: a direct run is a plain Claude Code
      // invocation, and the turn is allowed to use whatever this machine has
      // configured. If the user has git/edit/bash wired in this CLI session,
      // the prompt gets them.
      '--permission-mode', 'bypassPermissions',
    ];
    const spawnOpts = {
      cwd: process.env.HOME, // direct runs default to the home dir; the
      env: process.env,      // prompt can `cd` into a project if it wants to.
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    const child = spawn('claude', args, spawnOpts);
    let out = '';
    let err = '';
    // NDJSON accumulator. stream-json emits one JSON object per line, but a
    // chunk boundary can land mid-line, so lines are only parsed once the
    // newline arrives — splitting on every chunk would truncate JSON at random.
    let ndBuf = '';
    let streamedText = '';
    let sawResult = false;
    const onLine = (line) => {
      if (!line.trim()) return;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        return; // not a complete object; stream-json never splits across lines
      }
      // The session id rides the system init event. Capturing it here rather
      // than from the final result means a run that dies mid-turn still leaves
      // the fork reusable instead of re-forking (and re-paying) next time.
      if (typeof ev.session_id === 'string' && ev.session_id) {
        if (!directSession) {
          console.log(`[the-line] direct session forked -> ${ev.session_id.slice(0, 8)}`);
        }
        directSession = ev.session_id;
      }
      if (ev.type === 'stream_event') {
        const d = ev.event?.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text) {
          streamedText += d.text;
          // Hand over the accumulation, never the fragment — the wire is
          // unordered and a fragment that arrives late cannot be placed.
          if (job.onDelta) job.onDelta(streamedText);
        }
        return;
      }
      // The terminal frame carries the authoritative final text. Prefer it over
      // the accumulated deltas: tool use and thinking do not appear as
      // text_delta, so the two can legitimately differ.
      if (ev.type === 'result') {
        sawResult = true;
        if (typeof ev.result === 'string') out = ev.result;
        if (ev.is_error) err = String(ev.result ?? 'direct run failed');
      }
    };
    // SAME HEARTBEAT AS runTurn. A direct turn (`@the-line`) is the same
    // silent `-p` invocation: the CLI prints nothing until it finishes, so a
    // direct run that thinks longer than the server's 120s claim-stall was
    // killed as a dead poller. runTurn got a heartbeat; this path was missed,
    // so the fix only covered half the turns.
    let directElapsed = 0;
    let directBeat = null;
    const directFirst = setTimeout(() => {
      directElapsed = 45;
      if (job.onProgress) job.onProgress(directElapsed);
      directBeat = setInterval(() => {
        directElapsed += 60;
        if (job.onProgress) job.onProgress(directElapsed);
      }, 60_000);
    }, 45_000);
    const done = (r) => {
      clearTimeout(directFirst);
      if (directBeat !== null) clearInterval(directBeat);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done({ ok: false, text: '', error: 'direct run timed out' });
    }, TURN_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      ndBuf += d.toString();
      let i;
      while ((i = ndBuf.indexOf('\n')) >= 0) {
        onLine(ndBuf.slice(0, i));
        ndBuf = ndBuf.slice(i + 1);
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, text: '', error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // A final line with no trailing newline: stream-json's last frame may
      // arrive without one, and dropping it would lose the result text.
      if (ndBuf.trim()) onLine(ndBuf);
      const raw = out.trim();
      // A SESSION ID THIS MACHINE NO LONGER KNOWS makes the CLI refuse to
      // start, which surfaces as a dead prompt rather than an error. Same trap
      // runTurn already guards. Drop the id and run bare: context is worth
      // having, never at the cost of the answer.
      if (resumeArgs.length > 0 && !raw && /--resume|session/i.test(err)) {
        console.log('[the-line] direct resume rejected — retrying without it');
        directSession = null;
        const bare = args.filter((a, i) => {
          if (a === '--resume') return false;
          if (i > 0 && args[i - 1] === '--resume') return false;
          return a !== '--fork-session';
        });
        const retry = spawn('claude', bare, spawnOpts);
        let o2 = '';
        retry.stdout.on('data', (d) => { o2 += d.toString(); });
        retry.on('close', () => {
          const t2 = o2.trim();
          try {
            const j2 = JSON.parse(t2);
            done({ ok: true, text: typeof j2.result === 'string' ? j2.result.trim() : t2 });
          } catch {
            done({ ok: Boolean(t2), text: t2, error: t2 ? undefined : 'retry produced nothing' });
          }
        });
        return;
      }
      // `out` is the result frame's text, set by onLine; `streamedText` is what
      // the wall already rendered. Prefer the result, fall back to the stream —
      // a run killed after producing text should return what the person saw
      // rather than nothing.
      const text = (raw || streamedText).trim();
      if (sawResult && err && !raw) {
        done({ ok: false, text, error: err.trim().slice(0, 300) });
        return;
      }
      if (code === 0 && text) done({ ok: true, text });
      else done({ ok: false, text, error: err.trim().slice(0, 300) || `exited ${code}` });
    });
  });
}

// ---- agent turns -----------------------------------------------------------

/** Run one turn through the local `claude` CLI.
 *
 *  The CLI is the right engine here: it already carries this person's
 *  subscription and runs on THEIR disk, which is the entire reason a turn
 *  should not land on the server. The task's own systemGuidance carries the
 *  crew member's identity, so nothing about the persona lives in this file. */
/** RESIDENT PATH (P1/P2). One long-lived `claude` per crew member.
 *
 *  Measured before building: opus + Cal's charter on a trivial ask ran 7.5s
 *  wall against duration_api_ms of 1.7s — so ~5.8s of every turn was harness,
 *  not model. A persistent child does the same work in 1.7s on turn 2, with
 *  cache creation falling from 26,696 tokens to 44.
 *
 *  Behind RESIDENT_AGENTS because it changes the path EVERY crew turn runs
 *  through. A flag means a bad night is one env var away from the old
 *  behaviour instead of a rollback under pressure.
 *
 *  Returns runTurn's exact contract — { ok, text, error? } — so the caller
 *  cannot tell which engine answered. */
async function runTurnResident(job) {
  const t0 = Date.now();
  const agentId = job.agentId;
  if (!agentId) return { ok: false, text: '', error: 'no agentId for the resident pool' };
  try {
    const msg = await pool.ask(agentId, job.prompt, job.systemGuidance);
    const text = typeof msg?.result === 'string' ? msg.result.trim() : '';
    // duration_api_ms is the model's own share. Logged because the HUD has been
    // blaming Claude for harness time, and this is the number that separates
    // them.
    console.log(
      `[pool] ${agentId} turn ${Date.now() - t0}ms (api ${msg?.duration_api_ms ?? '?'}ms, ` +
        `cache_read ${msg?.usage?.cache_read_input_tokens ?? 0}, ` +
        `cache_new ${msg?.usage?.cache_creation_input_tokens ?? 0})`,
    );
    if (!text) return { ok: false, text: '', error: 'resident turn produced nothing' };
    return { ok: true, text };
  } catch (err) {
    // Fall back to a fresh process rather than failing the turn: a pool problem
    // should degrade to the old behaviour, not silence the agent.
    console.warn(`[pool] ${agentId} resident turn failed — falling back to a spawn:`, err?.message ?? err);
    return runTurnSpawn(job);
  }
}

function runTurn(job) {
  if (RESIDENT_AGENTS && job.agentId) return runTurnResident(job);
  return runTurnSpawn(job);
}

function runTurnSpawn(job) {
  return new Promise(async (resolve) => {
    // THE BRIDGE NEEDS ITS OWN CREDENTIAL. voice.mjs runs as a separate stdio
    // MCP server inside the spawned turn, so it cannot share this process's
    // in-memory token — it reads one from its env. Resolve it HERE, before the
    // spawn, because the device flow is async and this callback is not a place
    // to be starting an interactive auth.
    //
    // Falls back to LINE_TOKEN the same way authHeaders() does, so a machine on
    // the legacy path keeps working for this release.
    let bridgeToken = TOKEN;
    try {
      bridgeToken = await getAccessToken(BASE, (line) => console.log(line));
    } catch {
      /* keep the legacy token; the bridge reports its own failure if it has none */
    }
    const { prompt, systemGuidance, allowedTools } = job;
    // GENERATION TIMING. Nothing measured this before: the poller logged
    // "running locally" and "turn done" with no clock between them, so a turn
    // that took 80 seconds and one that hung were the same two lines.
    const t0 = Date.now();
    let firstTokenAt = 0;
    // Give the turn The Line's OWN MCP server, and nothing else.
    //
    // Without this the agent runs as a bare subprocess with no tools beyond the
    // filesystem: the task tells it to call `say` while it works, it cannot,
    // and the person watching sees an avatar marked "working" that never makes
    // a sound. `say` and submit_* are the wall's voice, so the turn has to be
    // able to reach them.
    //
    // --strict-mcp-config keeps it to exactly this server: the turn should not
    // inherit whatever else this machine happens to have connected.
    const args = [
      '-p', prompt,
      '--model', TURN_MODEL,
      '--append-system-prompt', systemGuidance,
      '--output-format', 'json',
      // CONTINUITY. Without --resume every turn spawned a brand new session, so
      // an agent that investigated something in one turn had no memory of it in
      // the next — it would honestly say no prior turn existed, because for it
      // none did. That is what made turns look like they "ran empty": the work
      // happened, then vanished.
      ...(job.resumeId ? ['--resume', job.resumeId] : []),
      // A STDIO bridge, not the HTTP endpoint. Claude Code will not use an
      // OAuth-protected HTTP server it has not authorised, and a headless
      // subprocess cannot run that flow — Lucy said so herself when this was
      // wired the other way. A stdio child needs no OAuth, and the poller's
      // token stays here rather than entering the turn's environment.
      '--mcp-config', JSON.stringify({
        mcpServers: {
          'the-line': {
            type: 'stdio',
            command: process.execPath,
            // P3 (option b): the AGENT, not the task. A task id is valid for one
            // turn; the bridge resolves the live one per call instead, so this
            // argv survives a persistent child that serves many turns.
            args: [new URL('./voice.mjs', import.meta.url).pathname, BASE, job.agentId],
            // By env, not argv — see voice.mjs. The turn's own prompt never
            // sees this, and the process table never prints it.
            // By env, not argv — see voice.mjs. BEARER is the device-flow
            // token; LINE_TOKEN stays for a bridge that predates it.
            env: bridgeToken.startsWith('at_')
              ? { LINE_BEARER: bridgeToken }
              : { LINE_TOKEN: bridgeToken },
          },
        },
      }),
      '--strict-mcp-config',
      // The turn is already running unattended; a permission prompt would hang
      // it forever with nobody there to answer.
      '--permission-mode', 'bypassPermissions',
    ];
    // The task names the tools the agent is allowed; pass them through rather
    // than inventing a set here. The Line's own tools ride along on top: an
    // allow-list that names Bash and Read but not `say` would silence the very
    // narration the task spends a page asking for.
    if (Array.isArray(allowedTools) && allowedTools.length > 0) {
      args.push('--allowed-tools', [...allowedTools, 'mcp__the-line'].join(','));
    }
    // A long turn with a quiet model would otherwise show an avatar "working"
    // and nothing else. Every 45s, say how long it has been — not a fake
    // progress report, just proof it is still alive and roughly how long it
    // has been at it, which is what the person actually wants to know.
    // Every 45s was too often: each heartbeat is a whole avatar cycle —
    // Protoface spin-up, LiveKit connect, four words, tear down — and on a long
    // turn they stacked in the voice queue ("1 minute in", "2 minutes in") while
    // the actual work waited behind them. A liveness ping does not need that
    // cadence; two minutes still answers "is it stuck?" without crowding out the
    // reply it is covering for.
    // FIRST tick at 45s, then every two minutes.
    //
    // The upfront opener is gone (see handle()), so this is now the ONLY thing
    // covering a silent turn — and a flat 2-minute first tick left a working
    // agent mute for two full minutes, which reads as stuck. 45s is long enough
    // that a normal turn answers first and says nothing, short enough that a
    // genuinely slow one speaks before the person starts wondering.
    //
    // The 2-minute cadence after that is deliberate and unchanged: each line is
    // a full avatar lifecycle, and on a long turn they used to stack in the
    // voice queue ("1 minute in", "2 minutes in") ahead of the actual reply.
    let elapsed = 0;
    const FIRST_TICK_MS = 45_000;
    // 60s, not the old 120s: the server's claim-stall window is 120s from the
    // LAST heartbeat, and a 120s cadence made the gap exactly 120s — a race
    // decided by network jitter. 60s keeps every gap at half the window.
    const HEARTBEAT_MS = 60_000;
    let heartbeat = null;
    const firstTick = setTimeout(() => {
      elapsed = FIRST_TICK_MS / 1000;
      if (job.onProgress) job.onProgress(elapsed);
      heartbeat = setInterval(() => {
        elapsed += HEARTBEAT_MS / 1000;
        if (job.onProgress) job.onProgress(elapsed);
      }, HEARTBEAT_MS);
    }, FIRST_TICK_MS);

    const spawnOpts = {
      cwd: job.cwd || process.env.HOME,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    // Re-run this same turn with the resume flag stripped. Used only when the
    // CLI rejects the session id outright.
    const retryWithout = () => {
      const clean = [];
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--resume') { i += 1; continue; }
        clean.push(args[i]);
      }
      const again = spawn('claude', clean, spawnOpts);
      let o2 = '';
      let e2 = '';
      again.stdout.on('data', (d) => { o2 += d.toString(); });
      again.stderr.on('data', (d) => { e2 += d.toString(); });
      again.on('error', (e) => done({ ok: false, text: '', error: e.message }));
      again.on('close', (c2) => {
        const raw2 = o2.trim();
        let t2 = raw2;
        let s2;
        try {
          const j2 = JSON.parse(raw2);
          t2 = typeof j2.result === 'string' ? j2.result.trim() : raw2;
          s2 = typeof j2.session_id === 'string' ? j2.session_id : undefined;
        } catch { /* raw */ }
        if (c2 === 0 && t2) done({ ok: true, text: t2, sessionId: s2 });
        else done({ ok: false, text: t2, sessionId: s2, error: e2.trim().slice(0, 300) || `exited ${c2}` });
      });
    };
    const child = spawn('claude', args, spawnOpts);
    reportMarks(job.taskId, [{ stage: 'spawned', note: `model=${TURN_MODEL}` }]);
    let out = '';
    let err = '';
    // Clear BOTH: the first-tick timeout and the interval it starts. Clearing
    // only the interval let a turn that finished inside 45s still fire a stray
    // "Still on it" after its own reply had landed.
    const done = (r) => {
      clearTimeout(firstTick);
      if (heartbeat !== null) clearInterval(heartbeat);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done({ ok: false, text: '', error: 'turn timed out' });
    }, TURN_TIMEOUT_MS);
    child.stdout.on('data', (d) => {
      // NOT A FIRST TOKEN. `--output-format json` BUFFERS the whole reply and
      // prints it once at exit, so this fires exactly once, at the end — the
      // same instant as `generated`. Reporting it as firstToken claimed to
      // measure model latency and actually measured nothing: on a turn still
      // running, it simply never arrived and the HUD showed it missing beside
      // `generated` and `settled`, which reads as a dead turn rather than a
      // working one.
      //
      // A real first-token mark needs --output-format stream-json, which is
      // what runDirect uses. That is a bigger change to the crew path (it
      // changes how the reply is parsed and how deltas reach the voice
      // pipeline), so it is deliberately NOT bundled into a HUD fix. The
      // honest thing meanwhile is to stop claiming a measurement we do not
      // have.
      if (!firstTokenAt) firstTokenAt = Date.now();
      out += d.toString();
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ ok: false, text: '', error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // GENERATION COMPLETE. Everything after this is synthesis and playback,
      // so this boundary is what separates "the model was slow" from "the
      // voice path stalled" — the two failures that look identical on the wall.
      // `--output-format json` buffers, so there is no writing-vs-thinking
      // split to report here: the whole interval is one opaque block. Say that
      // rather than printing a 0ms that looks like a measurement.
      reportMarks(job.taskId, [{
        stage: 'generated',
        note: `${Date.now() - t0}ms total (buffered — no token stream)`,
      }]);
      const raw = out.trim();
      // A resume id this machine does not know makes the CLI REFUSE to start
      // ("not a UUID and does not match any session title"), which surfaces as
      // a stalled turn. The server's ids can come from a different machine, so
      // retry clean: continuity is worth having, never at the cost of the turn.
      if (job.resumeId && !raw && /--resume|session/i.test(err)) {
        console.log('[the-line] resume rejected — retrying without it');
        retryWithout();
        return;
      }
      let text = raw;
      let sessionId;
      try {
        const j = JSON.parse(raw);
        text = typeof j.result === 'string' ? j.result.trim() : raw;
        sessionId = typeof j.session_id === 'string' ? j.session_id : undefined;
        if (j.is_error) {
          done({ ok: false, text, sessionId, error: String(j.result ?? 'turn failed').slice(0, 300) });
          return;
        }
      } catch {
        /* not json (older CLI, or it died before printing) — use raw */
      }
      if (code === 0 && text) done({ ok: true, text, sessionId });
      else done({ ok: false, text, sessionId, error: err.trim().slice(0, 300) || `exited ${code}` });
    });
  });
}

/** The project folder the turn should run in, parsed from its own guidance.
 *  The server states it there; reading it back beats hardcoding a path. */
function cwdFor(text) {
  const m = text.match(/The active project lives at:\s*(\S+)/);
  return m ? m[1] : process.env.HOME;
}

/** A short "picking this up" line built from the request itself, so the wall
 *  says something the moment work starts. Deliberately derived from the ask
 *  rather than generic: "On it — reviewing feat/x" tells the person their
 *  message landed, where "Working..." does not. */
async function handle(parts) {
  // Mechanical task: a {taskId, exec} struct rides alongside the prose.
  for (const text of parts) {
    try {
      const j = JSON.parse(text);
      if (j && j.taskId && j.exec) {
        const e = j.exec;
        let payload;
        try {
          if (e.op === 'list-dir') payload = await doListDir(e);
          else if (e.op === 'read-file') payload = await doReadFile(e);
          else if (e.op === 'diff') payload = await doDiff(e);
          else return false;
        } catch (err) {
          payload = { error: err instanceof Error ? err.message : String(err) };
        }
        await rpc('tools/call', { name: 'submit_exec', arguments: { taskId: j.taskId, ...payload } });
        console.log(`[the-line] exec ${e.op}`);
        return true;
      }
    } catch {
      /* the prose half */
    }
  }

  // Agent turn: the machine-readable copy carries prompt + guidance.
  for (const text of parts) {
    try {
      const j = JSON.parse(text);
      if (!j || !j.taskId || !j.prompt) continue;

      // DIRECT CLI TURN (`@the-line <prompt>` from the radio). The user asked
      // the laptop's Claude Code to do something on their own behalf — no
      // persona, no SDK session resume, no narration brief, no voice bridge.
      // The prompt runs as a plain `claude -p <prompt>` against THIS machine's
      // full tool set (git, edit, bash, etc.); the reply goes back through
      // submit_result and the server broadcasts it as a `the-line` chat bubble.
      // `taskId` is still required for routing; the rest of the runTurn args
      // are intentionally skipped below.
      if (j.direct === true) {
        // One in-flight delta at a time, per turn. See onDelta below.
        let deltaChain = Promise.resolve();
        const endWork = beginWork(null); // not an agent; nothing to report busy for
        try {
          // Materialise a dropped file BEFORE the run, and name it in the
          // prompt. Referencing a real path is what lets `claude -p` Read it;
          // a bare "the user attached an image" tells it something exists and
          // gives it no way to look.
          const attPath = await fetchAttachment(j.attachment);
          const promptWithFile = attPath
            ? `${j.prompt}\n\n[The user attached a file with this message: ${attPath} ` +
              `(${j.attachment.name}, ${j.attachment.mime}). Read it before answering.]`
            : j.prompt;
          const r = await runDirect({
            taskId: j.taskId,
            prompt: promptWithFile,
            systemGuidance: j.systemGuidance,
            // Stream the reply to the wall as it is produced.
            //
            // CUMULATIVE, AND SERIALISED. Each frame carries the whole reply so
            // far, not the new fragment, and frames are chained so only one is
            // in flight at a time.
            //
            // Both halves are required. The first version sent fragments with a
            // bare `void rpc(...)`: several HTTP POSTs raced, arrived out of
            // order, and the server concatenated them in ARRIVAL order — which
            // rendered as a reply with its sentences interleaved and then
            // repeated. Sending cumulative text makes a late frame harmless
            // (it is a stale snapshot, not a missing piece); chaining keeps the
            // newest frame last.
            //
            // Still fire-and-forget at the turn level: a dropped frame must
            // never stall or fail the turn, and submit_result carries the
            // authoritative text regardless.
            onDelta: (full) => {
              deltaChain = deltaChain
                .then(() =>
                  rpc('tools/call', {
                    name: 'submit_delta',
                    arguments: { taskId: j.taskId, text: full },
                  }),
                )
                .catch(() => undefined);
            },
            // Keep the server's claim-stall timer fed — see runDirect's note.
            onProgress: (elapsedS) => {
              void rpc('tools/call', {
                name: 'report_status',
                arguments: { taskId: j.taskId, status: `Still working — ${elapsedS}s in.` },
              }).catch(() => undefined);
            },
          });
          await rpc('tools/call', {
            name: 'submit_result',
            arguments: r.ok
              ? { taskId: j.taskId, text: r.text }
              : { taskId: j.taskId, text: r.text || 'I hit a problem running that.', ok: false, error: r.error },
          });
          console.log(`[the-line] direct run ${r.ok ? 'ok' : 'failed: ' + r.error}`);
          return true;
        } finally {
          endWork();
        }
      }

      // The narration brief lives in the PROSE half only — the JSON copy carries
      // just prompt + systemGuidance. Reading only the JSON meant the turn never
      // saw "speak while you work", so it worked in silence and the wall showed
      // an avatar marked busy that never made a sound.
      const prose = parts.find((p) => p.includes('SPEAK WHILE YOU WORK')) ??
        parts.find((p) => p.includes('YOUR WORKING DIRECTORY')) ?? '';
      // DO NOT NARRATE. The brief used to open with "BEFORE you touch any other
      // tool, call `say` once... that first line is not optional", plus a
      // standing request to keep speaking through the turn. That instruction is
      // why the crew talked over each other.
      //
      // Every spoken line is a full avatar lifecycle — Protoface spin-up,
      // LiveKit connect, a few words, tear down — and the voice queue is
      // SERIAL, so narration does not play underneath the answer: it queues
      // AHEAD of it. With several agents working, five "On it" lines land
      // before anyone's actual reply. A roll call made this unmistakable: all
      // five teammates opened by reciting Cal's page back, verbatim, at once.
      //
      // The wall already shows a working agent WITHOUT anyone speaking — the
      // card carries a `working` state and the Activity tab logs the turn. Only
      // silence long enough to read as genuinely stuck is worth a voice, and
      // that is caught server-side by SILENCE_LIMIT_MS (2 minutes).
      //
      // `say` remains available: an agent that finds something mid-turn worth
      // hearing may still use it. What is gone is the instruction to narrate by
      // default.
      const speakBrief =
        'Do NOT narrate your progress. Do not open with an acknowledgement, do not ' +
        'repeat the request back, and do not call `say` to report that you are starting, ' +
        'working, or finishing — the wall already shows you as working, and every spoken ' +
        'line delays the actual answer and can talk over a teammate. Just do the work and ' +
        'reply once, properly. Use `say` ONLY if you hit something the person needs to ' +
        'hear before the answer lands: a blocker, or a finding that changes what they ' +
        'asked for. Silence while you work is correct and expected.';
      console.log(`[the-line] turn for ${j.agent ?? j.agentId} — running locally`);
      // TELL THE SERVER A TURN IS RUNNING, from here, because here is the only
      // place that knows. Everything below — including the reply — happens
      // inside this window.
      // DISPATCH WITHOUT AWAITING — see turnsInFlight above.
      //
      // HAND IT BACK, DO NOT JUST DROP IT.
      //
      // Both declines below used to `return false` and say the task was "left
      // queued". It was not. Being handed a task IS the claim: the server
      // splices it out of the queue and arms the 120s stall timer BEFORE the
      // payload reaches us. A silent decline therefore leaves a claimed task
      // with nobody working it, and 120s later it settles `crashed`.
      //
      // That is what Darin's HUD was full of: Lucy `claimed 883ms`, then
      // `settled 120.9s crashed streamed=false`, spawned/generated/voiceStart/
      // turnComplete never arriving, while the siblings ahead of her in the same
      // roll call finished in 2-6s. The log line right above it read
      // "4 turns in flight (max 4) — leaving lucy queued".
      //
      // release_task undoes the claim and puts it back at the FRONT, so a
      // declined agent keeps their place in the roll call order.
      const handBack = async (taskId, reason) => {
        await rpc('tools/call', {
          name: 'release_task',
          arguments: { taskId, reason },
        }).catch((err) => console.warn('[the-line] could not hand back:', err?.message ?? err));
      };

      // One turn per agent: a second task for an agent already running would
      // interleave writes into that agent's single resumed Claude session.
      const thisAgent = j.agentId ?? j.agent;
      if (turnsInFlight.has(thisAgent)) {
        console.log(`[the-line] ${thisAgent} already has a turn in flight — handing it back`);
        await handBack(j.taskId, `${thisAgent} already has a turn in flight`);
        return false;
      }
      // A ceiling on total concurrency: each turn is a `claude` subprocess, and
      // the machine has to stay usable.
      if (turnsInFlight.size >= MAX_CONCURRENT_TURNS) {
        console.log(
          `[the-line] ${turnsInFlight.size} turns in flight (max ${MAX_CONCURRENT_TURNS}) — handing ${thisAgent} back`,
        );
        await handBack(j.taskId, `poller at its ceiling of ${MAX_CONCURRENT_TURNS} turns`);
        return false;
      }

      const endWork = beginWork(thisAgent);
      const turn = (async () => {
      try {
      // NO UPFRONT "ON IT".
      //
      // This used to fire an opener 3.5s into every turn — "On it." or, worse,
      // "On it — <the ask parroted back>". Asked for repeatedly and removed
      // here: it reads the person's own request back at them, and it costs a
      // FULL AVATAR LIFECYCLE (Protoface spin-up, LiveKit connect, a few words,
      // tear down) before the real reply has anywhere to go. Two power-ups for
      // one answer, with a session reap in between.
      //
      // Silence while working is covered by the heartbeat below, which speaks
      // only once the turn has actually been quiet long enough to read as
      // stuck. A fast turn now says nothing until it has something to say.

      // A WARM-UP IS NOT A TURN. It exists to populate the resident child's
      // prompt cache (first turn ~3.7s / 40k cache-creation tokens, every turn
      // after ~1.2s / ~40). Its reply is discarded here rather than submitted,
      // because a warm-up that reached the wall would have the crew greeting an
      // empty room on every page load — worse than the cold start it removes.
      if (j.warmOnly) {
        const t0 = Date.now();
        try {
          await runTurn({
            taskId: j.taskId,
            agentId: j.agentId ?? j.agent,
            prompt: j.prompt,
            systemGuidance: j.systemGuidance,
            allowedTools: j.allowedTools,
            cwd: cwdFor(''),
          });
          console.log(`[warm] ${j.agentId ?? j.agent} ready in ${Date.now() - t0}ms`);
        } catch (err) {
          console.warn(`[warm] ${j.agentId ?? j.agent} failed:`, err?.message ?? err);
        }
        // SETTLE IT, or the server waits out CLAIM_STALL_MS (120s) on a task
        // nobody is listening to — and under one wall lane that is 120s of the
        // crew being unable to answer.
        //
        // This called a bare `submitResult()` that DOES NOT EXIST. Node throws
        // ReferenceError only when the line runs, so nothing failed at load:
        // the warm turn completed on the poller (1.4-3.9s, visible in
        // /tmp/line-agent.log) and then died before reporting, leaving the
        // server to record `crashed` at exactly 120.0s. Six of those per page
        // load, which is what Darin's HUD was full of.
        //
        // Text is empty on purpose: a warm-up has nothing to say, and the whole
        // point is that it never reaches the wall.
        await rpc('tools/call', {
          name: 'submit_result',
          arguments: { taskId: j.taskId, text: '' },
        }).catch((err) => console.warn('[warm] could not settle:', err?.message ?? err));
        return;
      }

      const r = await runTurn({
        taskId: j.taskId,
        // P3: the bridge is spawned with this, not the task id, and resolves
        // the live task per call. `agent` is the older field name and some
        // payloads still carry only that — the poller already falls back this
        // way at the [the-line] turn log above, so match it rather than
        // assuming the newer name is always present.
        agentId: j.agentId ?? j.agent,
        ...(j.resumeId ? { resumeId: j.resumeId } : {}),
        prompt: j.prompt,
        systemGuidance: `${j.systemGuidance ?? ''}\n\n--- HOW TO SPEAK ON THE WALL ---\n${speakBrief}`,
        allowedTools: j.allowedTools,
        cwd: cwdFor(prose || j.systemGuidance || ''),
        // HEARTBEAT THROUGH report_status — SILENT since it moved to
        // pushProgress (wall + ops only, never the voice queue). It was
        // disabled here when every tick cost a full spoken avatar lifecycle;
        // that cost is gone, and without ANY heartbeat the server's 120s
        // claim-stall killed every turn that THOUGHT longer than 120s without
        // speaking: the CLI runs -p and prints nothing until it finishes, so a
        // long review turn was indistinguishable from a dead poller. Lucius
        // lost two review turns to this in one roll call (streamed=false
        // ms=120001, twice); Reese lost two the day before. The heartbeat is
        // the poller telling the server the child is still alive — which only
        // the poller knows. pushProgress re-arms the claim timer, so a slow
        // turn survives; a genuinely dead poller still sends nothing and still
        // dies at 120s, exactly as designed.
        onProgress: (elapsedS) => {
          void rpc('tools/call', {
            name: 'report_status',
            arguments: { taskId: j.taskId, status: `Still working — ${elapsedS}s in.` },
          }).catch(() => undefined);
        },
      });
      await rpc('tools/call', {
        name: 'submit_result',
        arguments: r.ok
          ? { taskId: j.taskId, text: r.text, ...(r.sessionId ? { sessionId: r.sessionId } : {}) }
          : {
              taskId: j.taskId,
              text: r.text || 'I hit a problem running that.',
              ok: false,
              error: r.error,
              ...(r.sessionId ? { sessionId: r.sessionId } : {}),
            },
      });
      console.log(`[the-line] turn done (${r.ok ? 'ok' : 'failed: ' + r.error})`);
      if (process.env.LINE_DEBUG) {
        console.log('[dbg] reply:', JSON.stringify((r.text || '').slice(0, 400)));
        if (r.error) console.log('[dbg] stderr:', r.error.slice(0, 400));
      }
      return true;
      } finally {
        endWork();
      }
      })().catch((e) => {
        // A throw here used to propagate into loop()'s catch, which resets the
        // MCP session and backs off — one bad turn stalled the whole poller.
        // Detached, it must handle its own failure or it becomes an unhandled
        // rejection that kills the process.
        console.log(`[the-line] turn for ${thisAgent} threw: ${e?.message ?? e}`);
      }).finally(() => {
        turnsInFlight.delete(thisAgent);
      });
      turnsInFlight.set(thisAgent, turn);
      console.log(
        `[the-line] turn for ${thisAgent} dispatched (${turnsInFlight.size} in flight)`,
      );
      // Claimed and running — but do NOT block the loop on it. Returning here
      // lets the next poll go out immediately, so the next agent starts
      // generating while this one is still thinking.
      return true;
    } catch {
      /* not the JSON half */
    }
  }
  return false;
}

async function loop() {
  let backoff = 1000;
  for (;;) {
    try {
      if (!sessionId && !(await handshake())) {
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }
      // NOT execOnly: this poller takes agent turns as well as mechanical work.
      //
      // `working` rides along on every poll. Between turns it is EMPTY, and that
      // is the point: an empty report is the server's only evidence for "this
      // machine is pulling and nobody is working", which is a different answer
      // from hearing nothing at all (no loop running, so nothing is known).
      const out = await rpc('tools/call', {
        name: 'get_pending_tasks',
        arguments: { workerId: WORKER_ID, working: [...working] },
      });
      if (!out || out.error) {
        sessionId = null;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }
      backoff = 1000;
      const parts = (out.result?.content ?? []).map((c) => c.text ?? '').filter(Boolean);
      // `handle` no longer blocks on a turn — it dispatches and returns. It
      // returns false when it DECLINED the work (that agent already has a turn
      // in flight, or the concurrency ceiling is reached), and the server will
      // hand the same task back on the next poll.
      //
      // Without a pause that is a hot loop: decline, re-poll, get it back,
      // decline. get_pending_tasks only parks for 25s when the queue is EMPTY;
      // with work waiting it returns at once. So wait for a slot to open before
      // asking again.
      const took = parts.length ? await handle(parts) : false;
      if (parts.length && !took && turnsInFlight.size > 0) {
        // Wake as soon as any in-flight turn finishes, or after a short tick —
        // whichever comes first. Racing the promises means a freed slot is taken
        // immediately rather than after a fixed delay.
        await Promise.race([
          Promise.allSettled([...turnsInFlight.values()]),
          new Promise((r) => setTimeout(r, DECLINE_PAUSE_MS)),
        ]);
      }
    } catch {
      sessionId = null;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

console.log(`[the-line] agent poller up (${WORKER_ID}) — turns run on this machine.`);
loop();
