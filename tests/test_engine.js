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

tests.emaSeedsWithSmaAndCarriesAcrossGaps = () => {
  const x = [1, 2, null, 3, 4, 5];
  const e = E.emaSeries(x, 3);
  assert.deepStrictEqual(e.slice(0, 3), [null, null, null]);
  assert.ok(near(e[3], 2));                                   // SMA(1,2,3)
  assert.ok(near(e[4], 2 + 0.5 * (4 - 2)));                   // alpha = 2/(3+1)
  assert.ok(near(e[5], e[4] + 0.5 * (5 - e[4])));
  assert.ok(near(E.emaStep(e[4], 5, 3), e[5]));               // in-progress bar = one step from prior state
  assert.strictEqual(E.emaStep(null, 5, 3), null);
};

tests.bollingerPopulationSigmaAndPartialWindow = () => {
  const x = [1, 2, 3, null, 4];
  const bb = E.bbSeries(x, 3, 2);
  assert.strictEqual(bb[1], null);
  const m = 2, sd = Math.sqrt(((1 - 2) ** 2 + 0 + (3 - 2) ** 2) / 3);
  assert.ok(near(bb[2].mid, m) && near(bb[2].up, m + 2 * sd) && near(bb[2].lo, m - 2 * sd));
  assert.strictEqual(bb[3], null);                            // empty bucket: no value
  assert.ok(near(bb[4].mid, 3));                              // window 2,3,4
  // in-progress bar: last period-1 closed values + current close
  const win = E.lastValues(x, 3, 2).concat([4]);
  assert.deepStrictEqual(win, [2, 3, 4]);
  assert.ok(near(E.bbOf(win, 2).mid, bb[4].mid));
};

tests.tradingRulesLongOnlyOnePosition = () => {
  assert.strictEqual(E.canOpen(null, 'blind'), null);
  assert.match(E.canOpen({}, 'blind'), /Already/);
  // same side again = add to the position; opposite side refused until closed
  assert.strictEqual(E.canOpen({ type: 'P' }, 'blind', 'P'), null);
  assert.match(E.canOpen({ type: 'P' }, 'blind', 'C'), /Holding a put/);
  assert.match(E.canOpen({ type: 'C' }, 'blind', 'P'), /Holding a call/);
  assert.match(E.canOpen({ type: 'P' }, 'review', 'P'), /BLIND/);
  assert.match(E.canOpen(null, 'review'), /BLIND/);             // never trade while the future is shown
  assert.match(E.canClose(null), /No open/);
  assert.strictEqual(E.canClose({}), null);
  assert.ok(near(E.optionPnl(14.95, 16.20, 2), 250));          // (exit bid − entry mid) × 100 × qty
};

tests.excursionUsesOnlyRowsInsideTheHold = () => {
  const t = [1000, 2000, 3000, 4000, 5000], bid = [9, 10, 12, 8, 30];
  const x = E.excursion(t, bid, [{ t: 2500, mid: 10, qty: 1 }], 4000);   // as-of entry row (2000) .. 4000
  assert.ok(near(x.mfe, 200) && near(x.mae, -200));
  assert.ok(!near(x.mfe, 2000), 'the 30 bid after nowT must not count');
};

tests.scaleInAveragesEntryAndNeverBackdatesSize = () => {
  const a = E.avgEntry([{ t: 1000, mid: 10, qty: 1 }, { t: 3000, mid: 13, qty: 2 }]);
  assert.strictEqual(a.qty, 3);
  assert.ok(near(a.mid, 12) && a.t === 1000);
  // P&L of the averaged position == the sum of the fills' P&L
  assert.ok(near(E.optionPnl(a.mid, 15, a.qty), E.optionPnl(10, 15, 1) + E.optionPnl(13, 15, 2)));
  const t = [1000, 2000, 3000, 4000], bid = [10, 16, 13, 11];
  const x = E.excursion(t, bid, [{ t: 1000, mid: 10, qty: 1 }, { t: 3000, mid: 13, qty: 2 }], 4000);
  // best = +600 at 2000 with ONE contract (the add came later), not 3 × (16−12) × 100;
  // worst = −300 at 4000 once all three are held: (11−10)·100 + (11−13)·200
  assert.ok(near(x.mfe, 600) && near(x.mae, -300), JSON.stringify(x));
  // after the add at 3000: 11 bid -> (11−10)·100 + (11−13)·200 = −300
  const y = E.excursion([1000, 3000, 4000], [10, 13, 11], [{ t: 1000, mid: 10, qty: 1 }, { t: 3000, mid: 13, qty: 2 }], 4000);
  assert.ok(near(y.mae, -300) && near(y.mfe, 300), JSON.stringify(y));
};

tests.scaledInTradeShowsOneMarkerPerFillWithTheClock = () => {
  const tr = [{ entry_t: 100, exit_t: 900, pnl: 50, label: 'P', exit_price: 2,
    fills: [{ t: 100, mid: 1, qty: 1 }, { t: 400, mid: 1.5, qty: 2 }] }];
  const style = { entry: 'b', exit: 'g', win: 'w', loss: 'l' };
  const id = (ms) => ms;
  assert.strictEqual(E.tradeMarkers(tr, 200, false, id, style).length, 1);    // the add is still future
  const m = E.tradeMarkers(tr, 1000, false, id, style);
  assert.deepStrictEqual(m.map((x) => x.time), [100, 400, 900]);
  assert.match(m[1].text, /^\+2 @1\.50$/);
};

tests.tradeMarkersRevealWithClockInBlind = () => {
  const trades = [{ entry_t: 100, exit_t: 500, entry_price: 1, exit_price: 2, pnl: 100, label: 'C' }];
  const timeOf = (ms) => ms;
  const style = { entry: 'b', exit: 'g', win: 'w', loss: 'l' };
  assert.strictEqual(E.tradeMarkers(trades, 50, false, timeOf, style).length, 0);
  assert.strictEqual(E.tradeMarkers(trades, 300, false, timeOf, style).length, 1);   // exit still hidden
  assert.strictEqual(E.tradeMarkers(trades, 300, true, timeOf, style).length, 2);    // review shows all
  assert.strictEqual(E.tradeMarkers(trades, 600, false, timeOf, style)[1].color, 'w');
};

tests.multiTimeframeMatchesSourceSeriesAtBarEnds = () => {
  const { c } = makeChart(1800, 5);                             // 30 min of 1s bars
  const b1m = E.buildBuckets(c.t, OPEN, OPEN + 1800000, 60000);
  const closes = E.fullOhlcv(c, b1m).map((x) => (x ? x.close : null));
  const bb = E.bbSeries(closes, 20, 2), ema = E.emaSeries(closes, 20);
  for (let m = 0; m < closes.length; m++) {
    if (closes[m] == null) continue;
    const a = E.mtfBB(closes, m, closes[m], 20, 2);
    assert.deepStrictEqual(a, bb[m], `BB at 1m bar ${m}`);
    const e = E.mtfEMA(closes, ema, m, closes[m], 20);
    assert.ok((e == null && ema[m] == null) || near(e, ema[m]), `EMA at 1m bar ${m}`);
  }
  // mid-bar on a 1s pane: only closed 1m bars + the price as of that second
  const m = 25, x = 123.45;
  const win = E.lastValues(closes, m - 1, 19).concat([x]);
  assert.deepStrictEqual(E.mtfBB(closes, m, x, 20, 2), E.bbOf(win, 2));
};

tests.connectorsAppearOnlyOnceExitReached = () => {
  const trades = [{ entry_t: 100, exit_t: 500, pnl: -40 }, { entry_t: 200, exit_t: null, pnl: null }];
  const style = { entry: 'b', exit: 'g', win: 'w', loss: 'l' };
  const priceAt = (ms) => ms / 100, timeOf = (ms) => ms;
  assert.strictEqual(E.tradeConnectors(trades, 400, false, timeOf, priceAt, style).length, 0);  // outcome not yet known
  const segs = E.tradeConnectors(trades, 500, false, timeOf, priceAt, style);
  assert.strictEqual(segs.length, 1);                                   // open trade has no segment
  assert.deepStrictEqual(segs[0], { t0: 100, p0: 1, t1: 500, p1: 5, color: 'l', text: '−$40' });
  assert.strictEqual(E.tradeConnectors(trades, 0, true, timeOf, priceAt, style).length, 1);    // review
};

tests.subSecondSnapshotsNeverEarlyNeverDoubleCounted = () => {
  // second 0 has a 1s bar (t=999) and sub snapshots at 249 / 499; second 1 likewise
  const c = {
    t: [999, 1999], o: [10, 12], h: [11, 13], l: [9, 12], c: [10.5, 12.5], v: [100, 50], n: [10, 5],
    sub: { t: [249, 499, 1249], o: [10, 10, 12], h: [10, 11, 12.2], l: [10, 9, 12], c: [10, 9.5, 12.2], v: [20, 60, 10], n: [2, 6, 1] },
  };
  const b = E.buildBuckets(c.t, 0, 60000, 60000);
  assert.strictEqual(E.ohlcvAsOf(c, b, 0, 248), null);                       // nothing before the first boundary
  assert.deepStrictEqual(E.ohlcvAsOf(c, b, 0, 300), { open: 10, high: 10, low: 10, close: 10, volume: 20, n: 2 });
  assert.strictEqual(E.ohlcvAsOf(c, b, 0, 800).close, 9.5);                  // latest snapshot, not the 1s bar
  assert.deepStrictEqual(E.ohlcvAsOf(c, b, 0, 999),                          // 1s bar visible: snapshot dropped
    { open: 10, high: 11, low: 9, close: 10.5, volume: 100, n: 10 });
  const mid = E.ohlcvAsOf(c, b, 0, 1300);                                    // bar 0 + second 1's snapshot
  assert.deepStrictEqual(mid, { open: 10, high: 12.2, low: 9, close: 12.2, volume: 110, n: 11 });
  assert.strictEqual(E.ohlcvAsOf(c, b, 0, 2000).volume, 150);                 // both 1s bars, no snapshots
  assert.strictEqual(E.priceAsOf(c, 1300), 12.2);
  assert.strictEqual(E.priceAsOf(c, 1100), 10.5);                            // second 1 has no snapshot yet
};

tests.tapeStatsUseOnlyFinishedSeconds = () => {
  const c = { t: [999, 1999, 2999, 3999], n: [10, 20, 30, 40] };
  const cum = E.tapeCum(c);
  const s = E.tapeStats(c, cum, 3500, 2000, 0);                              // window (1500, 3500]: 1999 + 2999
  assert.strictEqual(s.rate, 25);
  assert.strictEqual(s.total, 60);                                           // the 40 at 3999 not yet visible
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { fn(); console.log(`PASS engine.${name}`); }
  catch (e) { failed++; console.log(`FAIL engine.${name}: ${e.message}`); }
}
process.exit(failed ? 1 : 0);
