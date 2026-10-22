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
  const INTERVALS = { '1s': 1000, '5s': 5000, '15s': 15000, '1m': 60000, '5m': 300000 };
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
    bucketCloseValues, pickStrike, stepBoundary, parseClock, fmtClock, chartTime,
  };
});
