// ============================================================================
// No upfront "On it" — run with:
//   node --test plugin/the-line/tests/noOpener.test.mjs
//
// Every turn used to fire an opener 3.5s in: "On it." or, when the ask named
// anything at all, "On it — <the ask parroted back>". Two problems, both
// reported repeatedly:
//
//   1. It reads the person's own request back at them before answering.
//      Worst case, a handoff body contains an '@', which passed the opener's
//      "names something" test, so the receiving agent recited its own
//      instructions aloud:
//        Lucius: "On it — [Team handoff from Cal] Handed off to Lucius on the
//                 radio. Ball's in his court now — he…"
//   2. It costs a FULL AVATAR LIFECYCLE — Protoface spin-up, LiveKit connect,
//      a few words, tear down — before the real reply has anywhere to go. Two
//      power-ups for one answer, with a session reap in between.
//
// The opener is gone. Silence while working is covered by the heartbeat, which
// now speaks at 45s and then every two minutes — long enough that a normal turn
// answers first and says nothing at all.
//
// These replace firstLine.test.mjs and openerTiming.test.mjs, which pinned the
// behaviour that was removed.
// ============================================================================
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../bin/agent.mjs', import.meta.url), 'utf8');

describe('the opener is gone, not merely disabled', () => {
  test('firstLine() no longer exists', () => {
    assert.ok(!src.includes('function firstLine'), 'firstLine() is still defined');
  });

  test('OPENER_DELAY_MS no longer exists', () => {
    assert.ok(!src.includes('OPENER_DELAY_MS'), 'the opener timer constant is still there');
  });

  test('nothing calls `say` before the turn starts', () => {
    // The only `say` calls left are the heartbeat and whatever the agent itself
    // emits through the MCP tool. A literal "On it" opener must not reappear.
    assert.ok(!/text:\s*firstLine\(/.test(src), 'an opener is still being spoken');
  });
});

describe('the heartbeat covers working silence instead', () => {
  test('first tick is 45s', () => {
    assert.match(src, /FIRST_TICK_MS\s*=\s*45_000/, 'first heartbeat tick is not 45s');
  });

  test('the cadence stays inside the server stall window', () => {
    // The heartbeat now rides report_status (SILENT — pushProgress, wall-only)
    // and its real job is re-arming the server's 120s claim-stall: the CLI runs
    // -p and prints nothing until it finishes, so without a heartbeat any turn
    // that THOUGHT longer than 120s was killed as stalled — Lucius lost two
    // review turns to this in one roll call. The old 120s cadence raced that
    // window exactly (tick at 45s, next at 165s = a 120s gap); 60s keeps every
    // gap at half the window.
    assert.match(src, /HEARTBEAT_MS\s*=\s*60_000/, 'heartbeat cadence changed');
  });

  test('the heartbeat is wired to report_status, not to `say`', () => {
    // report_status posts to the wall without buying a clip. Wiring the
    // heartbeat back through `say` would resurrect the exact parrot this file
    // exists to keep dead.
    const cb = src.indexOf('onProgress: (elapsedS)');
    assert.ok(cb > 0, 'the heartbeat callback is missing (onProgress: undefined?)');
    const window = src.slice(cb, cb + 400);
    assert.match(window, /report_status/, 'heartbeat does not use report_status');
    assert.ok(!/name:\s*'say'/.test(window), 'heartbeat speaks — the parrot is back');
  });

  test('the first tick fires BEFORE the repeating interval starts', () => {
    // A flat setInterval(120s) left a working agent mute for two full minutes,
    // which reads as stuck now that nothing speaks up front.
    const i = src.indexOf('const firstTick = setTimeout');
    const j = src.indexOf('heartbeat = setInterval');
    assert.ok(i > 0 && j > i, 'the interval is not nested inside the first tick');
  });

  test('BOTH timers are cleared when the turn finishes', () => {
    // Clearing only the interval let a turn that finished inside 45s still fire
    // a stray "Still on it" after its own reply had landed.
    assert.match(src, /clearTimeout\(firstTick\)/, 'the first-tick timeout is never cleared');
    assert.match(src, /clearInterval\(heartbeat\)/, 'the heartbeat interval is never cleared');
  });
});
