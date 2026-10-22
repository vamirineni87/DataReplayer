// Node tests for web/engine.js. Run via tests/run_all.py (test_engine_js) or `node tests/test_engine.js`.
'use strict';
const assert = require('assert');
const path = require('path');
const E = require(path.join(__dirname, '..', 'web', 'engine.js'));

const OPEN = 9.5 * 3600e3, CLOSE = 16 * 3600e3;
const tests = {};

tests.asOfBoundaries = () => {
  const t = [1000, 2000, 3000];
  assert.strictEqual(E.asOfIndex(t, 999), -1);
  assert.strictEqual(E.asOfIndex(t, 1999), 0);          // never the future row
  assert.strictEqual(E.asOfIndex(t, 2000), 1);          // row at exactly T is visible
  assert.strictEqual(E.asOfIndex(t, 1e12), 2);
  assert.strictEqual(E.asOfIndex([], 5), -1);
};

tests.advanceClockClampsAndIsMonotonic = () => {
  assert.strictEqual(E.advanceClock(OPEN, 100, 10, OPEN, CLOSE), OPEN + 1000);
  assert.strictEqual(E.advanceClock(OPEN, 60000, 1, OPEN, CLOSE), OPEN + E.MAX_FRAME_MS);  // background-tab jump clamped
  assert.strictEqual(E.advanceClock(CLOSE - 10, 100, 600, OPEN, CLOSE), CLOSE);
  assert.strictEqual(E.advanceClock(OPEN + 5, -50, 1, OPEN, CLOSE), OPEN + 5);
};

tests.bucketsAlignedToOpenAndFoldClose = () => {
  const t = [OPEN, OPEN + 59999, OPEN + 60000, CLOSE];
  const b = E.buildBuckets(t, OPEN, CLOSE, 60000);
  assert.strictEqual(b.n, 390);
  assert.deepStrictEqual([b.first[0], b.last[0], b.first[1]], [0, 1, 2]);
  assert.strictEqual(b.last[389], 3);                   // 16:00:00 sample folds into the last bar
  assert.strictEqual(E.bucketOf(b, OPEN - 1), -1);
  assert.strictEqual(E.bucketOf(b, CLOSE), 389);
};

// The integrity core: random tape, random clocks — every visible value uses only t <= clock.
tests.noLookAheadRandomized = () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const t = [], p = [];
  let x = OPEN, px = 100;
  while (x <= CLOSE) { t.push(x); p.push(px += rnd() - 0.5); x += 1 + Math.floor(rnd() * 4000); }
  for (const I of Object.values(E.INTERVALS)) {
    const b = E.buildBuckets(t, OPEN, CLOSE, I);
    const closes = E.bucketCloseValues(t, p, b);
    for (let n = 0; n < 300; n++) {
      const clock = OPEN + Math.floor(rnd() * (CLOSE - OPEN + 1));
      const k = E.bucketOf(b, clock);
      const visible = t.filter(tt => tt <= clock).length;          // samples allowed
      const bar = E.barAsOf(t, p, b, k, clock);
      if (bar) {
        assert.strictEqual(bar.close, p[visible - 1], 'partial bar close = as-of price');
        const allowed = [];
        for (let i = b.first[k]; i < visible; i++) allowed.push(p[i]);
        assert.strictEqual(bar.high, Math.max(...allowed));
        assert.strictEqual(bar.low, Math.min(...allowed));
      }
      for (let j = Math.max(0, k - 3); j < k; j++) {                 // completed buckets
        const want = E.valueAsOf(t, p, b.starts[j] + I - 1);
        assert.strictEqual(closes[j], want);
        assert.ok(b.starts[j] + I - 1 < clock + 1, 'completed bucket ends at or before clock');
      }
    }
  }
};

tests.barAsOfNullBeforeFirstSampleInBucket = () => {
  const t = [OPEN + 30000];
  const b = E.buildBuckets(t, OPEN, CLOSE, 60000);
  assert.strictEqual(E.barAsOf(t, [1], b, 0, OPEN + 29999), null);
  assert.deepStrictEqual(E.barAsOf(t, [1], b, 0, OPEN + 30000), { open: 1, high: 1, low: 1, close: 1 });
};

tests.pickStrikeMatchesLiveTool = () => {
  const w = [140, 145, 150, 155, 160];
  assert.strictEqual(E.pickStrike(w, 150.1, 'C', 0), 150);
  assert.strictEqual(E.pickStrike(w, 152.5, 'C', 0), 150);    // tie -> lower
  assert.strictEqual(E.pickStrike(w, 150.1, 'C', 1), 155);    // + = OTM call
  assert.strictEqual(E.pickStrike(w, 150.1, 'P', 1), 145);    // + = OTM put
  assert.strictEqual(E.pickStrike(w, 150.1, 'P', 9), 140);    // clamped
};

tests.stepBoundary = () => {
  assert.strictEqual(E.stepBoundary(OPEN, 60000, 1, OPEN, CLOSE), OPEN + 60000);
  assert.strictEqual(E.stepBoundary(OPEN + 30000, 60000, 1, OPEN, CLOSE), OPEN + 60000);
  assert.strictEqual(E.stepBoundary(OPEN + 30000, 60000, -1, OPEN, CLOSE), OPEN);
  assert.strictEqual(E.stepBoundary(OPEN + 60000, 60000, -1, OPEN, CLOSE), OPEN);
  assert.strictEqual(E.stepBoundary(OPEN, 60000, -1, OPEN, CLOSE), OPEN);
  assert.strictEqual(E.stepBoundary(CLOSE, 60000, 1, OPEN, CLOSE), CLOSE);
};

tests.parseAndFormatClock = () => {
  assert.strictEqual(E.parseClock('10:32'), (10 * 60 + 32) * 60000);
  assert.strictEqual(E.parseClock('1032'), (10 * 60 + 32) * 60000);
  assert.strictEqual(E.parseClock('10:32:15'), ((10 * 60 + 32) * 60 + 15) * 1000);
  assert.strictEqual(E.parseClock('25:00'), null);
  assert.strictEqual(E.fmtClock(OPEN + 1234, true), '09:30:01.234');
};

tests.chartTimeDisplaysEtWallClock = () => {
  const s = E.chartTime('2026-08-28', OPEN);
  assert.strictEqual(new Date(s * 1000).toISOString(), '2026-08-28T09:30:00.000Z');
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`PASS engine.${name}`); }
  catch (e) { failed++; console.log(`FAIL engine.${name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
