// ============================================================================
// The Line — device authorization for the background pollers (RFC 8628).
//
// WHY THIS EXISTS: poll.sh and agent.sh are processes spawned by a Claude Code
// plugin monitor. They have no browser and no access to the MCP client's token
// store, so the ordinary authorization-code flow cannot reach them. Until now
// they read a long-lived `LINE_TOKEN` out of a hand-written
// ~/.the-line/poller.env — a file nothing in the product ever told anyone to
// create. Installing the plugin on a clean machine therefore produced two
// monitors that started, found no token, and exited silently.
//
// The device grant is the standard answer: ask the server for a code, print a
// short one for the person, and they approve it in a browser they already have
// open. What we end up holding is an ordinary OAuth access/refresh pair —
// audience-bound, expiring, revocable — not a bearer secret that lives forever.
//
// Tokens are cached in ~/.the-line/tokens.json at 0600. The file is outside the
// plugin so an upgrade cannot clobber it, and is never committed.
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DIR = join(homedir(), '.the-line');
const STORE = join(DIR, 'tokens.json');
/** Refresh this far before expiry rather than waiting for a 401 — a poller that
 *  discovers its token died mid-long-poll has already dropped work. */
const REFRESH_SKEW_MS = 5 * 60_000;

function readStore() {
  try {
    return JSON.parse(readFileSync(STORE, 'utf8'));
  } catch {
    return null;
  }
}

function writeStore(data) {
  mkdirSync(dirname(STORE), { recursive: true, mode: 0o700 });
  writeFileSync(STORE, JSON.stringify(data, null, 2), { mode: 0o600 });
  // mkdir's mode is subject to umask; chmod is not.
  try {
    chmodSync(STORE, 0o600);
  } catch {
    /* best effort */
  }
}

async function post(base, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

/** Register this machine as a public OAuth client, once. The client_id is cached
 *  with the tokens so a re-auth does not create a new registration each time. */
async function ensureClient(base, store) {
  if (store?.client_id) return store.client_id;
  const { json } = await post(base, '/oauth/register', {
    client_name: `The Line poller (${process.env.USER ?? 'machine'})`,
    // The device flow never redirects, but registration requires the field.
    redirect_uris: ['urn:ietf:wg:oauth:2.0:oob'],
    token_endpoint_auth_method: 'none',
  });
  if (!json?.client_id) throw new Error('could not register with the server');
  return json.client_id;
}

/**
 * Get a usable access token, running the device flow if needed.
 *
 * @param {string} base      e.g. https://line.cmdshift.ai
 * @param {(line: string) => void} say  where to print the user-facing prompt
 * @returns {Promise<string>} a Bearer access token
 */
export async function getAccessToken(base, say = console.log) {
  let store = readStore();

  // 1) Still valid? Use it.
  if (store?.access_token && store.expires_at - REFRESH_SKEW_MS > Date.now()) {
    return store.access_token;
  }

  // 2) Refresh, if we can. A refresh failure is not fatal — fall through to a
  //    fresh device flow rather than wedging the poller forever.
  if (store?.refresh_token) {
    const { ok, json } = await post(base, '/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: store.refresh_token,
      client_id: store.client_id,
    });
    if (ok && json.access_token) {
      store = {
        ...store,
        access_token: json.access_token,
        refresh_token: json.refresh_token ?? store.refresh_token,
        expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
      };
      writeStore(store);
      return store.access_token;
    }
  }

  // 3) Device flow.
  const clientId = await ensureClient(base, store);
  const { ok, json: auth } = await post(base, '/oauth/device_authorization', {
    client_id: clientId,
  });
  if (!ok || !auth.device_code) {
    throw new Error(auth.error_description ?? auth.error ?? 'could not start device authorization');
  }

  // PRINT IT LOUDLY. This is the one moment the flow needs a person, and it is
  // happening in a monitor's output that nobody is necessarily watching — so it
  // says what to do, not just a code.
  say('');
  say('  ┌─────────────────────────────────────────────┐');
  say('  │  The Line — connect this machine            │');
  say('  └─────────────────────────────────────────────┘');
  say('');
  say(`  Open:  ${auth.verification_uri_complete ?? auth.verification_uri}`);
  say(`  Code:  ${auth.user_code}`);
  say('');
  say('  Waiting for you to approve…');
  say('');

  const deadline = Date.now() + (auth.expires_in ?? 600) * 1000;
  let interval = (auth.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const { ok: tokOk, json: tok } = await post(base, '/oauth/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: auth.device_code,
      client_id: clientId,
    });
    if (tokOk && tok.access_token) {
      const next = {
        client_id: clientId,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at: Date.now() + (tok.expires_in ?? 3600) * 1000,
      };
      writeStore(next);
      say('  Connected. Your crew is awake.');
      return next.access_token;
    }
    // RFC 8628 error semantics: pending is normal, slow_down means back off,
    // anything else is terminal.
    if (tok.error === 'authorization_pending') continue;
    if (tok.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    if (tok.error === 'access_denied') throw new Error('that machine was declined');
    if (tok.error === 'expired_token') break;
    throw new Error(tok.error_description ?? tok.error ?? 'device authorization failed');
  }
  throw new Error('the code expired before it was approved');
}
