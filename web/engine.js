/* Replay engine — pure functions, no DOM (unit-tested under Node: tests/test_engine.js).
 *
 * Time axis: `t` = integer ms since ET midnight of the session date (slicer meta.time_axis).
 *
 * NO LOOK-AHEAD (SPEC §5): everything visible "as of clock" comes from samples with
 * t <= clock. In particular there is NO interpolation toward the next sample (SPEC §4B's
 * suggestion would leak the next tick's direction); smoothness comes from the fixed-rate
 * clock and the in-progress candle instead.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SPEEDS = [0.25, 0.5, 1, 2, 3, 5, 10, 30, 60, 600];   // last = "Max"
  const INTERVALS = { '1s': 1000, '5s': 5000, '15s': 15000, '1m': 60000, '2m': 120000, '5m': 300000 };
  const MAX_FRAME_MS = 250;   // clamp real dt (background tab / debugger) so the clock never leaps

  /** Index of the last sample with t[i] <= at, or -1. `t` sorted ascending. */
  function asOfIndex(t, at) {
    let lo = 0, hi = t.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= at) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function valueAsOf(t, v, at) {
    const i = asOfIndex(t, at);
    return i < 0 ? null : v[i];
  }

  /** Session clock advance on a render frame: speed changes how much session time
   *  elapses per real ms; never runs past close, never goes backwards. */
  function advanceClock(clock, realDtMs, speed, openMs, closeMs) {
    const dt = Math.max(0, Math.min(realDtMs, MAX_FRAME_MS));
    return Math.min(closeMs, Math.max(openMs, clock + dt * speed));
  }

  /** Bucket grid [open, close) of width I, aligned to the open. Samples with
   *  t >= close fold into the last bucket. first/last = sample index range (-1 if empty). */
  function buildBuckets(t, openMs, closeMs, intervalMs) {
    const n = Math.max(1, Math.ceil((closeMs - openMs) / intervalMs));
    const starts = new Array(n), first = new Int32Array(n).fill(-1), last = new Int32Array(n).fill(-1);
    for (let k = 0; k < n; k++) starts[k] = openMs + k * intervalMs;
    for (let i = 0; i < t.length; i++) {
      if (t[i] < openMs) continue;
      const k = Math.min(n - 1, Math.floor((t[i] - openMs) / intervalMs));
      if (first[k] < 0) first[k] = i;
      last[k] = i;
    }
    return { starts, first, last, intervalMs, openMs, closeMs, n };
  }

  function bucketOf(b, at) {
    if (at < b.openMs) return -1;
    return Math.min(b.n - 1, Math.floor((at - b.openMs) / b.intervalMs));
  }

  function aggregate(p, i0, i1) {
    let h = -Infinity, l = Infinity;
    for (let i = i0; i <= i1; i++) { if (p[i] > h) h = p[i]; if (p[i] < l) l = p[i]; }
    return { open: p[i0], high: h, low: l, close: p[i1] };
  }

  /** OHLC of bucket k using only samples with t <= clock (null if none yet). */
  function barAsOf(t, p, b, k, clock) {
    const i0 = b.first[k];
    if (i0 < 0 || t[i0] > clock) return null;
    const i1 = Math.min(b.last[k], asOfIndex(t, clock));
    return aggregate(p, i0, i1);
  }

  /** Complete OHLC for every bucket (review mode / the completed prefix in blind mode). */
  function fullBars(p, b) {
    const out = new Array(b.n);
    for (let k = 0; k < b.n; k++) out[k] = b.first[k] < 0 ? null : aggregate(p, b.first[k], b.last[k]);
    return out;
  }

  /** Per-bucket line value = as-of the bucket's last instant (null before the first sample).
   *  For a bucket fully before the clock this never reads past the clock. */
  function bucketCloseValues(t, v, b) {
    const out = new Array(b.n);
    for (let k = 0; k < b.n; k++) {
      const end = k === b.n - 1 ? Math.max(b.closeMs, b.starts[k] + b.intervalMs - 1) : b.starts[k] + b.intervalMs - 1;
      out[k] = valueAsOf(t, v, end);
    }
    return out;
  }

  // ---------------------------------------------------------------- chart bars (OHLCV)
  // `c` = slicer `chart` block: 1s bars {t, o, h, l, c, v, vv, pv, p2v, ref}, t = second end.
  // v = all volume (bars); vv/pv/p2v = VWAP-eligible volume and its price sums (centred on ref).

  function aggOhlcv(c, i0, i1) {
    let h = -Infinity, l = Infinity, v = 0;
    for (let i = i0; i <= i1; i++) { if (c.h[i] > h) h = c.h[i]; if (c.l[i] < l) l = c.l[i]; v += c.v[i]; }
    return { open: c.o[i0], high: h, low: l, close: c.c[i1], volume: v };
  }

  /** OHLCV of bucket k from 1s bars with t <= clock (null if none yet). */
  function ohlcvAsOf(c, b, k, clock) {
    const i0 = b.first[k];
    if (i0 < 0 || c.t[i0] > clock) return null;
    return aggOhlcv(c, i0, Math.min(b.last[k], asOfIndex(c.t, clock)));
  }

  function fullOhlcv(c, b) {
    const out = new Array(b.n);
    for (let k = 0; k < b.n; k++) out[k] = b.first[k] < 0 ? null : aggOhlcv(c, b.first[k], b.last[k]);
    return out;
  }

  // ---------------------------------------------------------------- VWAP + σ bands
  /** Per-1s-bar cumulative session VWAP and volume-weighted σ (trade-level exact). */
  function vwapSeries(c) {
    const n = c.t.length, vwap = new Float64Array(n), sd = new Float64Array(n);
    let V = 0, PV = 0, P2V = 0;
    for (let i = 0; i < n; i++) {
      V += c.vv[i]; PV += c.pv[i]; P2V += c.p2v[i];
      const m = V > 0 ? PV / V : 0;
      vwap[i] = c.ref + m;
      sd[i] = Math.sqrt(Math.max(0, P2V / V - m * m));
    }
    return { vwap, sd };
  }

  // ---------------------------------------------------------------- volume profile
  // Each 1s bar's VWAP-eligible volume goes to the row of its own VWAP (ref + pv/vv); rows are
  // `rowSize` wide, centred on multiples of rowSize. Up/down split by bar direction.
  const VP_SPAN = 8000;          // rows allocated around ref (±400 $ at 0.05)

  function profileRows(c, rowSize) {
    const base = Math.round(c.ref / rowSize) - VP_SPAN / 2;
    const row = new Int32Array(c.t.length);
    for (let i = 0; i < c.t.length; i++) {
      const px = c.vv[i] > 0 ? c.ref + c.pv[i] / c.vv[i] : c.c[i];
      const r = Math.round(px / rowSize) - base;
      row[i] = Math.max(0, Math.min(VP_SPAN - 1, r));
    }
    return { base, row };
  }

  /** Value area around `poc` holding >= vaPct of total (expand toward the larger neighbour). */
  function valueArea(H, lo0, hi0, poc, total, vaPct) {
    let lo = poc, hi = poc, acc = H[poc];
    const target = total * vaPct;
    while (acc < target) {
      const up = hi + 1 <= hi0 ? H[hi + 1] : -1;
      const dn = lo - 1 >= lo0 ? H[lo - 1] : -1;
      if (up < 0 && dn < 0) break;
      if (up >= dn) { hi++; acc += up; } else { lo--; acc += dn; }
    }
    return [lo, hi];
  }

  /** Developing POC / VAH / VAL after each 1s bar (prices), for the step lines. */
  function profileSeries(c, rowSize, vaPct) {
    vaPct = vaPct || 0.7;
    const n = c.t.length, { base, row } = profileRows(c, rowSize);
    const H = new Float64Array(VP_SPAN);
    const poc = new Float64Array(n), vah = new Float64Array(n), val = new Float64Array(n);
    let total = 0, p = -1, lo0 = VP_SPAN, hi0 = -1;
    for (let i = 0; i < n; i++) {
      const r = row[i];
      H[r] += c.vv[i]; total += c.vv[i];
      if (r < lo0) lo0 = r;
      if (r > hi0) hi0 = r;
      if (p < 0 || H[r] > H[p]) p = r;          // ties keep the earlier POC
      const [lo, hi] = valueArea(H, lo0, hi0, p, total, vaPct);
      poc[i] = (base + p) * rowSize; vah[i] = (base + hi) * rowSize; val[i] = (base + lo) * rowSize;
    }
    return { poc, vah, val };
  }

  /** Profile histogram from 1s bars 0..endIdx: rows [{price, up, down}], poc/vah/val prices, max. */
  function profileAsOf(c, rowSize, endIdx, vaPct) {
    vaPct = vaPct || 0.7;
    if (endIdx < 0) return null;
    const { base, row } = profileRows(c, rowSize);
    const up = new Map(), dn = new Map(), H = new Float64Array(VP_SPAN);
    let total = 0, lo0 = VP_SPAN, hi0 = -1, p = -1;
    for (let i = 0; i <= endIdx; i++) {
      const r = row[i], m = c.c[i] >= c.o[i] ? up : dn;
      m.set(r, (m.get(r) || 0) + c.vv[i]);
      H[r] += c.vv[i]; total += c.vv[i];
      if (r < lo0) lo0 = r;
      if (r > hi0) hi0 = r;
      if (p < 0 || H[r] > H[p]) p = r;
    }
    const [lo, hi] = valueArea(H, lo0, hi0, p, total, vaPct);
    const rows = [];
    let max = 0;
    for (let r = lo0; r <= hi0; r++) {
      if (!H[r]) continue;
      rows.push({ price: (base + r) * rowSize, up: up.get(r) || 0, down: dn.get(r) || 0, inVA: r >= lo && r <= hi });
      if (H[r] > max) max = H[r];
    }
    return { rows, max, rowSize, poc: (base + p) * rowSize, vah: (base + hi) * rowSize, val: (base + lo) * rowSize };
  }

  // ---------------------------------------------------------------- EMA / Bollinger
  // Causal over a bar-close sequence with gaps (null = empty bucket: state carries, no value).
  // EMA seeds with the SMA of the first `period` closes. BB = SMA ± mult × population σ
  // (TradingView's ta.stdev is the biased/population form).

  /** EMA state after each index (carried across nulls; null until seeded). */
  function emaSeries(x, period) {
    const a = 2 / (period + 1), out = new Array(x.length);
    let ema = null, seedSum = 0, seedN = 0;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (v != null) {
        if (ema == null) {
          seedSum += v; seedN++;
          if (seedN === period) ema = seedSum / period;
        } else ema += a * (v - ema);
      }
      out[i] = ema;
    }
    return out;
  }

  /** One EMA step from a previous state (for the in-progress bar). */
  function emaStep(prev, v, period) {
    return prev == null || v == null ? null : prev + (2 / (period + 1)) * (v - prev);
  }

  /** The last n non-null values of x at indices <= end (oldest first). */
  function lastValues(x, end, n) {
    const out = [];
    for (let i = Math.min(end, x.length - 1); i >= 0 && out.length < n; i--) if (x[i] != null) out.push(x[i]);
    return out.reverse();
  }

  function bbOf(win, mult) {
    const n = win.length;
    let s = 0;
    for (const v of win) s += v;
    const m = s / n;
    let q = 0;
    for (const v of win) q += (v - m) * (v - m);
    const sd = Math.sqrt(q / n);
    return { mid: m, up: m + mult * sd, lo: m - mult * sd };
  }

  /** Bollinger at each index with a value (null before `period` closes exist). */
  function bbSeries(x, period, mult) {
    const out = new Array(x.length).fill(null), win = [];
    for (let i = 0; i < x.length; i++) {
      if (x[i] == null) continue;
      win.push(x[i]);
      if (win.length > period) win.shift();
      if (win.length === period) out[i] = bbOf(win, mult);
    }
    return out;
  }

  // ---------------------------------------------------------------- multi-timeframe EMA / BB
  // Indicator computed on SOURCE bars (e.g. 1m) and shown on any pane (e.g. 1s). At a display
  // instant inside source bar `idx`, the value uses the completed source closes before `idx`
  // plus `x` = the price as of that instant — TradingView's developing higher-timeframe value,
  // and never anything after the instant. At a source bar's end it equals the plain series.

  /** BB at source index idx with in-progress close x (null until `len` closes exist). */
  function mtfBB(closes, idx, x, len, mult) {
    if (x == null || idx == null) return null;
    const win = lastValues(closes, idx - 1, len - 1).concat([x]);
    return win.length === len ? bbOf(win, mult) : null;
  }
  /** EMA at source index idx with in-progress close x; emaState = emaSeries(closes, len).
   *  On the seeding bar (len-th close) it is the SMA, exactly like emaSeries. */
  function mtfEMA(closes, emaState, idx, x, len) {
    if (x == null || idx == null) return null;
    const prev = idx > 0 ? emaState[idx - 1] : null;
    if (prev != null) return emaStep(prev, x, len);
    const win = lastValues(closes, idx - 1, len - 1);
    return win.length === len - 1 ? (win.reduce((a, v) => a + v, 0) + x) / len : null;
  }

  // ---------------------------------------------------------------- trading (SPEC §3)
  // Long-only, one position at a time; entry @ mid, exit @ bid; P&L = (exit − entry) × 100 × qty.

  /** Reason the open is refused, or null if allowed. */
  function canOpen(pos, mode) {
    if (mode !== 'blind') return 'Switch to BLIND to trade (REVIEW shows the future)';
    if (pos) return 'Already in a position — x to close';
    return null;
  }
  function canClose(pos) { return pos ? null : 'No open position'; }
  function optionPnl(entryMid, bid, qty) { return (bid - entryMid) * 100 * qty; }

  /** MFE / MAE ($) of a long option held from entryT to nowT, marked to the bid as of each row. */
  function excursion(t, bid, entryT, nowT, entryMid, qty) {
    let i = asOfIndex(t, entryT);
    if (i < 0) i = 0;
    let hi = -Infinity, lo = Infinity;
    for (let j = i; j < t.length && t[j] <= nowT; j++) {
      if (bid[j] > hi) hi = bid[j];
      if (bid[j] < lo) lo = bid[j];
    }
    if (hi === -Infinity) return { mfe: 0, mae: 0 };
    return { mfe: optionPnl(entryMid, hi, qty), mae: optionPnl(entryMid, lo, qty) };
  }

  /** Chart markers for trades. In blind mode (reveal=false) an entry/exit appears only once the
   *  clock reaches it. timeOf(ms) maps a session instant to the pane's bar time. Sorted by time. */
  function tradeMarkers(trades, clock, reveal, timeOf, style) {
    const out = [];
    for (const tr of trades) {
      const label = tr.label || '';
      if (tr.entry_t != null && (reveal || tr.entry_t <= clock)) {
        out.push({ time: timeOf(tr.entry_t), position: 'belowBar', shape: 'arrowUp', color: style.entry,
          text: `${label}${tr.entry_price != null ? ' @' + Number(tr.entry_price).toFixed(2) : ''}` });
      }
      if (tr.exit_t != null && (reveal || tr.exit_t <= clock)) {
        const pnl = tr.pnl != null ? ` ${tr.pnl >= 0 ? '+' : '−'}$${Math.abs(tr.pnl).toFixed(0)}` : '';
        out.push({ time: timeOf(tr.exit_t), position: 'aboveBar', shape: 'arrowDown',
          color: tr.pnl == null ? style.exit : tr.pnl >= 0 ? style.win : style.loss,
          text: `${tr.exit_price != null ? '@' + Number(tr.exit_price).toFixed(2) : ''}${pnl}` });
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }

  /** Live tool's OptionWindow.pick: nearest strike (ties -> lower), + offset = OTM, clamped. */
  function pickStrike(strikes, price, type, offset) {
    const s = strikes.slice().sort((a, b) => a - b);
    let i = 0;
    for (let j = 1; j < s.length; j++) if (Math.abs(s[j] - price) < Math.abs(s[i] - price)) i = j;
    const target = type === 'P' ? i - offset : i + offset;
    return s[Math.max(0, Math.min(target, s.length - 1))];
  }

  /** Next/previous bar boundary from `clock` (dir = +1 / -1), clamped to the session. */
  function stepBoundary(clock, intervalMs, dir, openMs, closeMs) {
    const rel = clock - openMs;
    let k = dir > 0 ? Math.floor(rel / intervalMs) + 1 : Math.ceil(rel / intervalMs) - 1;
    return Math.min(closeMs, Math.max(openMs, openMs + k * intervalMs));
  }

  /** "10:32", "10:32:15", "1032" -> session ms, or null. */
  function parseClock(s) {
    const m = String(s).trim().match(/^(\d{1,2}):?(\d{2})(?::?(\d{2}))?$/);
    if (!m) return null;
    const h = +m[1], mi = +m[2], se = +(m[3] || 0);
    if (h > 23 || mi > 59 || se > 59) return null;
    return ((h * 60 + mi) * 60 + se) * 1000;
  }

  function fmtClock(ms, withMs) {
    ms = Math.max(0, Math.floor(ms));
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    const pad = (x, n) => String(x).padStart(n || 2, '0');
    return `${pad(h)}:${pad(m)}:${pad(s % 60)}` + (withMs ? `.${pad(ms % 1000, 3)}` : '');
  }

  /** Chart time (lightweight-charts UTCTimestamp seconds) that DISPLAYS as the ET wall clock. */
  function chartTime(sessionDateIso, ms) {
    const [y, mo, d] = sessionDateIso.split('-').map(Number);
    return Date.UTC(y, mo - 1, d) / 1000 + Math.floor(ms / 1000);
  }

  return {
    SPEEDS, INTERVALS, MAX_FRAME_MS,
    asOfIndex, valueAsOf, advanceClock, buildBuckets, bucketOf, barAsOf, fullBars,
    bucketCloseValues, mtfBB, mtfEMA, canOpen, canClose, optionPnl, excursion, tradeMarkers, emaSeries, emaStep, lastValues, bbOf, bbSeries, ohlcvAsOf, fullOhlcv, vwapSeries, profileSeries, profileAsOf, valueArea, pickStrike, stepBoundary, parseClock, fmtClock, chartTime,
  };
});
