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

// Synthetic 1s chart bars built from synthetic trades, exactly as the slicer does.
function makeChart(nSec, seedInit) {
  let seed = seedInit || 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const trades = [];
  let px = 500;
  for (let s = 0; s < nSec; s++) {
    if (rnd() < 0.2) continue;                                   // some seconds have no trades
    const n = 1 + Math.floor(rnd() * 5);
    for (let j = 0; j < n; j++) {
      px = Math.round((px + (rnd() - 0.5) * 0.1) * 100) / 100;
      trades.push({ sec: s, p: px, v: 1 + Math.floor(rnd() * 300) });
    }
  }
  const ref = trades[0].p;
  const c = { ref, t: [], o: [], h: [], l: [], c: [], v: [], vv: [], pv: [], p2v: [] };
  for (const tr of trades) {
    const t = OPEN + tr.sec * 1000 + 999, last = c.t.length - 1;
    const d = tr.p - ref;
    if (last < 0 || c.t[last] !== t) {
      c.t.push(t); c.o.push(tr.p); c.h.push(tr.p); c.l.push(tr.p); c.c.push(tr.p);
      c.v.push(tr.v); c.vv.push(tr.v); c.pv.push(tr.v * d); c.p2v.push(tr.v * d * d);
    } else {
      c.h[last] = Math.max(c.h[last], tr.p); c.l[last] = Math.min(c.l[last], tr.p); c.c[last] = tr.p;
      c.v[last] += tr.v; c.vv[last] += tr.v; c.pv[last] += tr.v * d; c.p2v[last] += tr.v * d * d;
    }
  }
  return { c, trades };
}
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-9);

tests.vwapAndSigmaMatchBruteForceOverTrades = () => {
  const { c, trades } = makeChart(600);
  const { vwap, sd } = E.vwapSeries(c);
  for (const i of [0, 10, 100, c.t.length - 1]) {
    const upto = trades.filter((tr) => OPEN + tr.sec * 1000 + 999 <= c.t[i]);
    const V = upto.reduce((a, tr) => a + tr.v, 0);
    const m = upto.reduce((a, tr) => a + tr.v * tr.p, 0) / V;
    const s = Math.sqrt(upto.reduce((a, tr) => a + tr.v * (tr.p - m) ** 2, 0) / V);
    assert.ok(near(vwap[i], m, 1e-9), `vwap ${vwap[i]} vs ${m}`);
    assert.ok(near(sd[i], s, 1e-9), `sd ${sd[i]} vs ${s}`);
  }
};

tests.developingProfileMatchesFromScratch = () => {
  const { c } = makeChart(900, 11);
  const dev = E.profileSeries(c, 0.05);
  for (const i of [0, 1, 50, 300, c.t.length - 1]) {
    const snap = E.profileAsOf(c, 0.05, i);
    assert.ok(near(dev.poc[i], snap.poc) && near(dev.vah[i], snap.vah) && near(dev.val[i], snap.val), `row ${i}`);
    const total = snap.rows.reduce((a, r) => a + r.up + r.down, 0);
    const inVA = snap.rows.filter((r) => r.inVA).reduce((a, r) => a + r.up + r.down, 0);
    assert.ok(inVA >= 0.7 * total - 1e-9, 'value area holds >= 70%');
    assert.ok(snap.val <= snap.poc && snap.poc <= snap.vah);
    const pocRow = snap.rows.find((r) => near(r.price, snap.poc));
    assert.strictEqual(pocRow.up + pocRow.down, snap.max, 'POC is the heaviest row');
  }
  assert.strictEqual(E.profileAsOf(c, 0.05, -1), null);
};

tests.ohlcvAsOfNeverUsesUnfinishedSeconds = () => {
  const { c } = makeChart(600, 3);
  const b = E.buildBuckets(c.t, OPEN, OPEN + 600000, 60000);
  for (let clock = OPEN; clock < OPEN + 600000; clock += 777) {
    const k = E.bucketOf(b, clock);
    const bar = E.ohlcvAsOf(c, b, k, clock);
    const vis = [];
    for (let i = 0; i < c.t.length; i++) if (c.t[i] <= clock && E.bucketOf(b, c.t[i]) === k) vis.push(i);
    if (!vis.length) { assert.strictEqual(bar, null); continue; }
    assert.strictEqual(bar.close, c.c[vis[vis.length - 1]]);
    assert.strictEqual(bar.volume, vis.reduce((a, i) => a + c.v[i], 0));
    assert.strictEqual(bar.high, Math.max(...vis.map((i) => c.h[i])));
  }
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`PASS engine.${name}`); }
  catch (e) { failed++; console.log(`FAIL engine.${name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
