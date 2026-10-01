// ============================================================================
// One poller per machine — run with:
//   node --test plugin/the-line/tests/singleton.test.mjs
//
// Both pollers are declared as plugin monitors with "when": "always", so EVERY
// Claude Code session that loads the plugin started its own pair. Two sessions
// open meant four processes, all polling the same account with the same token
// but distinct PID-derived worker ids (`agent-$$`, `plugin-$$`).
//
// The server hands a queued turn to whichever worker polls first, so more than
// one AGENT poller is a race — and the failure is silent. Observed live: a hail
// to Cal returned "No reply from Cal" after the 60s hard cap while two agent
// pollers were up. The one with 8s of CPU had been doing the work; the one with
// 0.3s had claimed that turn and produced nothing. Nothing logged an error;
// the work simply vanished into the idle instance.
//
// bin/singleton.sh makes the first session to start win and every later one
// exit 0 quietly. A monitor that no-ops is the correct outcome here, not an
// error — nothing is killed, the duplicate just declines to duplicate.
//
// mkdir, not flock: flock(1) is absent on macOS by default and this runs on a
// laptop. mkdir is atomic on every POSIX filesystem, which is all this needs.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const LOCKS = join(homedir(), '.the-line', 'locks');

// Each test uses its own lock name so a real poller running on this machine is
// never touched, and so the tests cannot interfere with one another.
let n = 0;
const freshName = () => `selftest-${process.pid}-${++n}`;
const lockDir = (name) => join(LOCKS, `${name}.lock`);

/** Acquire in a throwaway shell. Returns {ok, out} — ok=false means it deferred. */
function tryAcquire(name, { hold = false } = {}) {
  // `hold` keeps the process alive briefly so a second caller sees a LIVE pid;
  // without it the holder exits and its EXIT trap frees the lock immediately.
  const script =
    `. "${BIN}/singleton.sh"; line_singleton "${name}" && echo ACQUIRED` +
    (hold ? '; sleep 0.3' : '');
  try {
    const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' });
    return { ok: out.includes('ACQUIRED'), out };
  } catch (e) {
    return { ok: false, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

test('first caller acquires the lock', () => {
  const name = freshName();
  try {
    const r = tryAcquire(name);
    assert.equal(r.ok, true, `should acquire, got: ${r.out}`);
  } finally {
    rmSync(lockDir(name), { recursive: true, force: true });
  }
});

test('a second caller defers while the holder is alive', () => {
  const name = freshName();
  const dir = lockDir(name);
  try {
    // Simulate a live holder: our own pid is by definition alive.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), String(process.pid));

    const r = tryAcquire(name);
    assert.equal(r.ok, false, 'second caller must NOT acquire');
    assert.match(r.out, /already running/, `should explain why, got: ${r.out}`);
    assert.match(r.out, new RegExp(String(process.pid)), 'should name the holder');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale lock (dead holder) is reclaimed, not respected', () => {
  // The self-healing property. Without it, one crashed session would wedge the
  // feature until a human noticed and deleted a directory by hand.
  const name = freshName();
  const dir = lockDir(name);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), '999999'); // not a live pid

    const r = tryAcquire(name);
    assert.equal(r.ok, true, `stale lock should be reclaimed, got: ${r.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock directory with no pid file is reclaimed', () => {
  // Possible if a process is killed between mkdir and the pid write.
  const name = freshName();
  const dir = lockDir(name);
  try {
    mkdirSync(dir, { recursive: true });
    const r = tryAcquire(name);
    assert.equal(r.ok, true, `pidless lock should be reclaimed, got: ${r.out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the lock is released when the holder exits cleanly', () => {
  // So closing a session frees the slot immediately, rather than leaving the
  // next one to wait on staleness detection.
  const name = freshName();
  const r = tryAcquire(name);
  assert.equal(r.ok, true, 'precondition: should acquire');
  assert.equal(existsSync(lockDir(name)), false, 'lock should be gone after exit');
});

test('the guard BITES: without it, two callers both acquire', () => {
  // CLAUDE.md: a regression test is only trusted once it has been shown to fail
  // against the old behaviour. The old behaviour was no guard at all, so both
  // callers proceeded — which is precisely the race described in the header.
  const name = freshName();
  const noGuard = 'line_singleton() { return 0; }';
  const run = () =>
    execFileSync('bash', ['-c', `${noGuard}; line_singleton "${name}" && echo ACQUIRED`], {
      encoding: 'utf8',
    });

  assert.match(run(), /ACQUIRED/, 'first acquires');
  assert.match(run(), /ACQUIRED/, 'second ALSO acquires — the bug this guard fixes');
});
