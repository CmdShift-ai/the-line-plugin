// ============================================================================
// The Line — background poller (the part that actually does the work).
//
// This runs as a plugin MONITOR: a separate, long-lived process. It claims
// MECHANICAL tasks only and executes them itself with Node's own fs/child_process.
// It never asks the model for anything, which is the whole point — a monitor can
// emit notifications but cannot make Claude call a tool, so anything that must
// happen reliably has to happen HERE.
//
// Scope, deliberately narrow: list a directory, read a file, produce a git diff.
// Every op is confined to the project root the server names, and nothing here
// takes a shell string from the wire — the server sends an enumerated op, so a
// compromised or confused server still cannot run arbitrary commands.
// ============================================================================
import { readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { getAccessToken } from './deviceAuth.mjs';

const run = promisify(execFile);
const [, , BASE, WORKER_ID] = process.argv;
// LEGACY FALLBACK, kept for one release. A machine connected before the device
// flow existed still has LINE_TOKEN in ~/.the-line/poller.env, and cutting it
// off in the same change that introduces the replacement would stop every
// currently-working poller until its owner noticed and re-authed.
const TOKEN = process.env.LINE_TOKEN ?? '';

/** Auth for an MCP request.
 *
 *  OAuth first (device flow — see deviceAuth.mjs), legacy header second. The
 *  pollers have no browser, so the device grant is how they get a real token;
 *  `x-line-token` is what mcp/mount.ts calls "legacy… slated for removal once
 *  everyone has migrated". */
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
const MAX_FILE_BYTES = 600 * 1024;
// A binary the BROWSER can render gets sent as base64 and becomes a data: URL.
// Everything else binary stays refused — this is a viewer, not a download pipe.
// Kept generous and generic on purpose: these are whatever formats a user's own
// project happens to contain, not this repo's.
const VIEWABLE_BINARY = new Map(Object.entries({
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
  ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  flac: 'audio/flac', aac: 'audio/aac',
  pdf: 'application/pdf',
}));
// Bigger than the text cap: a short video is legitimately megabytes, and the
// point of the viewer is to see it. Still bounded — the bytes travel as base64
// through a JSON body, which inflates them by a third.
const MAX_BINARY_BYTES = 20 * 1024 * 1024;
const MAX_PATCH_LINES = 4000;

let sessionId = null;

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
  // Streamable HTTP answers as SSE; take the data line.
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
    clientInfo: { name: 'the-line-poller', version: '0.1.0' },
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

/** Keep every op inside the project root the server named. A path that escapes
 *  it is refused rather than clamped — silently reading the wrong file is worse
 *  than failing. */
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
  const entries = items
    .filter((d) => d.name !== '.git' && d.name !== 'node_modules')
    .map((d) => ({ name: d.name, dir: d.isDirectory() }));
  return { entries };
}

async function doReadFile(spec) {
  const file = resolveInRoot(spec.root, spec.path);
  if (!file) return { error: 'path escapes the project root' };
  const st = await stat(file);
  if (!st.isFile()) return { error: 'not a file' };

  // Images, video, audio and PDFs go as bytes — the browser renders them
  // natively, so there is nothing to read as text.
  const dot = file.lastIndexOf('.');
  const ext = dot === -1 ? '' : file.slice(dot + 1).toLowerCase();
  const mediaType = VIEWABLE_BINARY.get(ext);
  if (mediaType) {
    if (st.size > MAX_BINARY_BYTES) {
      return { skipped: true, reason: `${Math.round(st.size / (1024 * 1024))}MB — too large to load` };
    }
    const buf = await readFile(file);
    return { binary: buf.toString('base64'), mediaType };
  }

  if (st.size > MAX_FILE_BYTES) {
    return { skipped: true, reason: `${Math.round(st.size / 1024)}KB — too large to display` };
  }
  const buf = await readFile(file);
  // A NUL in the first chunk is the cheap, reliable binary test. Anything that
  // reaches here is a binary we have no viewer for, so say so rather than
  // rendering mojibake.
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
  // ONE call for every patch, then split it. Running `git diff -- <file>` per
  // file spawned a process per changed file — on a 181-file branch that blew
  // past the timeout, while a single call returns the same bytes in ~0.2s.
  const { stdout: all } = await git(['diff', `${base}...${branch}`]);

  const patches = [];
  // Each file's patch starts at a `diff --git a/x b/y` line; slice on those.
  const lines = all.split('\n');
  let curPath = null;
  let buf = [];
  const flush = () => {
    if (curPath === null) return;
    const patch = buf.join('\n');
    // Omit an oversized patch entirely — the server renders that as an explicit
    // skip. Sending half a diff would read as the whole change.
    if (buf.length <= MAX_PATCH_LINES) patches.push({ path: curPath, patch });
    buf = [];
  };
  for (const line of lines) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      flush();
      curPath = m[2];
    }
    if (curPath !== null) buf.push(line);
  }
  flush();
  return { numstat, patches };
}

async function handle(parts) {
  // The server sends a machine-readable {taskId, exec} alongside the prose
  // instruction. Read that — parsing English would be guesswork, and this
  // process is not a model.
  let job = null;
  for (const text of parts) {
    try {
      const j = JSON.parse(text);
      if (j && j.taskId && j.exec) { job = j; break; }
    } catch {
      /* the prose half — ignore */
    }
  }
  if (!job) return false;
  const { taskId, exec } = job;
  let payload;
  try {
    if (exec.op === 'list-dir') payload = await doListDir(exec);
    else if (exec.op === 'read-file') payload = await doReadFile(exec);
    else if (exec.op === 'diff') payload = await doDiff(exec);
    else return false;
  } catch (e) {
    payload = { error: e instanceof Error ? e.message : String(e) };
  }
  const sub = await rpc('tools/call', { name: 'submit_exec', arguments: { taskId, ...payload } });
  if (!sub || sub.error) {
    console.log(`[the-line] submit failed: ${sub ? JSON.stringify(sub.error).slice(0, 200) : 'no response'}`);
  }
  const what = payload.entries
    ? `listed ${payload.entries.length} entries`
    : payload.patches
      ? `built a diff of ${payload.patches.length} files`
      : payload.skipped
        ? `skipped a file (${payload.reason})`
        : payload.error
          ? `failed: ${payload.error}`
          : 'read a file';
  console.log(`[the-line] ${what}`);
  return true;
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
      const out = await rpc('tools/call', {
        name: 'get_pending_tasks',
        arguments: { workerId: WORKER_ID, execOnly: true },
      });
      if (!out || out.error) {
        // A dead session (restart, expiry) just means handshake again.
        sessionId = null;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
        continue;
      }
      backoff = 1000;
      const parts = (out.result?.content ?? []).map((c) => c.text ?? '').filter(Boolean);
      if (parts.length) await handle(parts);
    } catch {
      sessionId = null;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

console.log(`[the-line] background poller up (${WORKER_ID}) — mechanical work only.`);
loop();
