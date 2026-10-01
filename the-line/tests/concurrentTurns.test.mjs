// ============================================================================
// Turns generate concurrently; one per agent; speech stays serial.
//   node --test plugin/the-line/tests/concurrentTurns.test.mjs
//
// WHAT CHANGED AND WHY. loop() used to `await handle(parts)`, so this process ran
// exactly one turn at a time — the next poll did not happen until the current
// `claude` subprocess exited. With turns running 60-107s (measured on prod), a
// six-way roll call was six sequential subprocesses, and the wall sat silent
// between speakers. Most of the wait was GENERATION, not talking.
//
// Darin: "we want them to answer serially that's the point how would the person
// understand if they all speak at once" — correct, and unchanged. SPEECH stays
// strictly serial: one voice, in order. Only GENERATION is now concurrent, so
// the next agent is already writing while the current one talks.
//
// THE LIMIT THAT MATTERS. One turn per AGENT, never two. Each agent resumes its
// own Claude session (`--resume <sessionId>`); two concurrent turns for the same
// agent would interleave writes into one session and corrupt its memory.
// Different agents resume different sessions and are safe.
//
// WHY THIS IS SAFE ONLY NOW. This file's own comments record what concurrent
// turns used to cause: "with several agents working the crew talked over each
// other", because narration queued AHEAD of replies in a serial voice queue.
// 5f27239 made the server hold the speaking floor until the room is actually
// quiet, so concurrent generation no longer implies concurrent speech.
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const MAX_CONCURRENT_TURNS = 4;

/** The dispatcher, reduced to its decisions. `concurrent: false` reproduces the
 *  shipped await-per-turn behaviour. */
function makeDispatcher(opts = {}) {
  const { concurrent = true, max = MAX_CONCURRENT_TURNS } = opts;
  const turnsInFlight = new Map();
  const working = new Set();
  const declined = [];
  /** Peak simultaneous turns, and the order they were dispatched. */
  let peak = 0;
  const dispatched = [];
  let livenessTimer = null;
  let livenessStops = 0;

  const beginWork = (agentId) => {
    working.add(agentId);
    if (!livenessTimer) livenessTimer = 'running';
    return () => {
      working.delete(agentId);
      if (working.size === 0 && livenessTimer) {
        livenessTimer = null;
        livenessStops++;
      }
    };
  };

  /** Returns true if the turn was taken. Each turn resolves via its own gate. */
  const handle = (agentId) => {
    if (turnsInFlight.has(agentId)) {
      declined.push({ agentId, why: 'agent-busy' });
      return { took: false };
    }
    if (turnsInFlight.size >= max) {
      declined.push({ agentId, why: 'ceiling' });
      return { took: false };
    }
    let finish;
    const gate = new Promise((r) => { finish = r; });
    const endWork = beginWork(agentId);
    const turn = gate
      .then(() => {})
      .catch((e) => { declined.push({ agentId, why: `threw:${e.message}` }); })
      .finally(() => { endWork(); turnsInFlight.delete(agentId); });
    turnsInFlight.set(agentId, turn);
    dispatched.push(agentId);
    peak = Math.max(peak, turnsInFlight.size);
    // The shipped behaviour: block until this turn finishes.
    // `turn` is always returned so a test can await ONE turn; `blocking` mirrors
    // the shipped code, which awaited it inline.
    return { took: true, finish, turn, blocking: concurrent ? null : turn };
  };

  return {
    handle, turnsInFlight, working, declined, dispatched,
    peak: () => peak,
    livenessRunning: () => livenessTimer !== null,
    livenessStops: () => livenessStops,
  };
}

describe('turn dispatch — concurrent generation', () => {
  test('BITES: awaiting each turn means peak concurrency of one', async () => {
    const d = makeDispatcher({ concurrent: false });
    for (const a of ['cal', 'lucius', 'reese']) {
      const r = d.handle(a);
      r.finish();
      await r.blocking; // the shipped `await handle(parts)`
    }
    assert.equal(d.peak(), 1, 'shipped behaviour: strictly one turn at a time');
    assert.deepEqual(d.dispatched, ['cal', 'lucius', 'reese'], 'in order, but serial');
  });

  test('detached dispatch runs several agents at once', async () => {
    const d = makeDispatcher();
    const runs = ['cal', 'lucius', 'reese'].map((a) => d.handle(a));
    assert.equal(d.turnsInFlight.size, 3, 'three subprocesses generating together');
    assert.equal(d.peak(), 3);
    runs.forEach((r) => r.finish());
    await Promise.all(runs.map((r) => r.turn));
  });

  test('ONE TURN PER AGENT — a second task for a busy agent is declined', async () => {
    // The session-corruption guard. Cal resumes ONE Claude session; two
    // concurrent turns writing into it would interleave.
    const d = makeDispatcher();
    const first = d.handle('cal');
    const second = d.handle('cal');
    assert.equal(second.took, false, 'declined, not run');
    assert.deepEqual(d.declined, [{ agentId: 'cal', why: 'agent-busy' }]);
    assert.equal(d.turnsInFlight.size, 1, 'still just the one cal turn');
    first.finish();
    await first.turn;
    // Once it finishes, cal can take work again.
    const third = d.handle('cal');
    assert.equal(third.took, true, 'the slot frees up');
    third.finish();
    await third.turn;
  });

  test('the concurrency ceiling holds and leaves work QUEUED, not dropped', async () => {
    const d = makeDispatcher({ max: 4 });
    const runs = ['cal', 'lucius', 'reese', 'dee'].map((a) => d.handle(a));
    assert.equal(d.turnsInFlight.size, 4);
    const fifth = d.handle('lucy');
    assert.equal(fifth.took, false, 'not claimed');
    assert.deepEqual(d.declined, [{ agentId: 'lucy', why: 'ceiling' }]);
    // Declining is the point: the server keeps it and hands it back. Nothing lost.
    runs[0].finish();
    await runs[0].turn; // cal's slot is now free
    const retry = d.handle('lucy');
    assert.equal(retry.took, true, 'and it runs as soon as a slot opens');
    runs.slice(1).forEach((r) => r.finish());
    retry.finish();
    await Promise.all([...runs.slice(1).map((r) => r.turn), retry.turn]);
  });

  test('a six-way roll call reaches the ceiling, never exceeds it', async () => {
    const d = makeDispatcher({ max: 4 });
    const crew = ['cal', 'lucius', 'reese', 'dee', 'lucy', 'susan'];
    const taken = crew.map((a) => d.handle(a)).filter((r) => r.took);
    assert.equal(taken.length, 4, 'four run, two wait');
    assert.equal(d.peak(), 4, 'and the ceiling is never breached');
    assert.equal(d.declined.length, 2);
    taken.forEach((r) => r.finish());
    await Promise.all(taken.map((r) => r.turn));
    assert.equal(d.turnsInFlight.size, 0, 'all slots free afterwards');
  });

  test('a throwing turn frees its slot and does not poison the poller', async () => {
    // Detached, a rejection must be caught locally. Unhandled, it would kill the
    // process; propagated into loop()'s catch it would reset the MCP session and
    // back off — one bad turn stalling the whole poller.
    const d = makeDispatcher();
    const bad = d.handle('cal');
    const good = d.handle('lucius');
    bad.finish();
    await bad.turn;
    assert.equal(d.turnsInFlight.has('cal'), false, 'slot released');
    assert.equal(d.turnsInFlight.has('lucius'), true, 'the other turn is untouched');
    good.finish();
    await good.turn;
    assert.equal(d.turnsInFlight.size, 0);
  });

  test('the liveness heartbeat survives until the LAST turn ends', async () => {
    // It exists because the main loop used to block. With several turns in
    // flight, the first one finishing must not stop it for the others.
    const d = makeDispatcher();
    const a = d.handle('cal');
    const b = d.handle('reese');
    assert.equal(d.livenessRunning(), true);
    a.finish();
    await a.turn;
    assert.equal(d.livenessRunning(), true, 'reese is still working');
    assert.deepEqual([...d.working], ['reese']);
    b.finish();
    await b.turn;
    assert.equal(d.livenessRunning(), false, 'stopped once nobody is working');
    assert.equal(d.livenessStops(), 1, 'and stopped exactly once');
  });
});
