/* Replay UI: two configurable panes + master clock + HUD + trading + journal.
 * Pure (look-ahead-sensitive, unit-tested) logic lives in engine.js.
 *
 * Each pane shows one SOURCE at its own interval:
 *   chart       stock trades of the chart symbol (SPY for SPXW): candles, volume, session VWAP
 *               ± σ bands, developing POC/VAH/VAL, volume profile, EMA, Bollinger
 *   underlying  the option root's underlying (SPX for SPXW): candles
 *   options     the selected call/put mids (selection follows the as-of underlying)
 *   none        pane hidden
 * Indicators are per pane (chips). EMA / BB each have a length and a SOURCE timeframe, so
 * "BB 20 on 1m" reads the same on a 1s pane (developing 1m value, as of the clock).
 * View presets just set both panes; changing a pane makes the view "custom".
 *
 * HISTORY: 1m+ chart panes prepend N prior sessions (server-built 1m bars with each day's own
 * VWAP/σ, POC/VAH/VAL, profile) — wholly in the past, so always shown. 1m+ EMA/BB warm up on it.
 *
 * BLIND renders only what is known as of the clock (completed bars + the in-progress bar from
 * samples t <= clock); trade markers reveal as the clock reaches them. REVIEW shows the whole
 * session; trading is refused there (SPEC §5 rule 8).
 *
 * TRADING (SPEC §3): c / p buy the offset-selected call / put at the MID, x sells at the BID,
 * long only, one position. The browser prices instantly from its 1s data, then re-prices from the
 * full tick tape at the exact instant (/api/quote). Closed trades go to journal/trades.jsonl.
 */
(function () {
  'use strict';
  const E = window.Engine;
  const LC = window.LightweightCharts;
  const $ = (id) => document.getElementById(id);

  const BANDS = [1.8, 2, 2.2, 2.5, 3];
  const PRESETS = {
    tv: { label: 'TradingView: SPY 1m + 1s', panes: [['chart', '1m'], ['chart', '1s']] },
    classic: { label: 'Classic: underlying + options', panes: [['underlying', '1m'], ['options', '1m']] },
    chartopt: { label: 'SPY 1m + options', panes: [['chart', '1m'], ['options', '1m']] },
  };
  // Matches the operator's TradingView: blue VWAP, orange 2σ, thin gray for the other bands.
  const COLORS = {
    up: '#26a69a', down: '#ef5350', vwap: '#2962ff', band: 'rgba(170,176,186,0.55)', band2: '#ff9800',
    poc: '#e6c229', va: 'rgba(225,225,225,0.85)', call: '#3fb950', put: '#f85149',
    ema: '#00bcd4', bb: 'rgba(186,104,200,0.85)', bbMid: 'rgba(186,104,200,0.5)',
  };
  const MARKER_STYLE = {
    practice: { entry: '#58a6ff', exit: '#58a6ff', win: '#3fb950', loss: '#f85149' },
    broker: { entry: '#e6c229', exit: '#e6c229', win: '#e6c229', loss: '#ff9800' },
    upload: { entry: '#ba68c8', exit: '#ba68c8', win: '#ba68c8', loss: '#ba68c8' },
  };
  const HIST_MIN_IV = 60000;            // history only on 1m-or-coarser chart panes
  // lightweight-charts 4.2 re-walks EVERY row of a series on each repaint after an update, so a
  // series' cost grows with its length (a 1s pane at 15:40 = 22k rows x ~17 series per frame).
  // In BLIND each series therefore holds a sliding window of the newest WIN_ROWS rows (trimmed
  // in WIN_SLACK steps, only while following the newest bar); scrolling to its left edge
  // grows it back by WIN_GROW rows. REVIEW (no per-frame updates) keeps everything.
  const WIN_ROWS = 2500, WIN_SLACK = 500, WIN_GROW = 2000;
  const TF_CHOICES = ['chart', '1s', '5s', '15s', '1m', '2m', '5m', '15m', '30m', '1h', '1D'];
  const TF_MS = { ...E.INTERVALS, '15m': 900000, '30m': 1800000, '1h': 3600000 };
  const DAILY_BARS = 100;               // prior daily closes fetched for 1D EMA/BB (warm-up)
  const defaultInd = () => ({
    vwap: true, bands: true, vp: true, vol: true, tape: true,
    ema: { on: false, len: 20, tf: '1m' },
    bb: { on: false, len: 20, mult: 2, tf: '1m' },
  });

  // ------------------------------------------------------------------ prefs
  const PREFS_KEY = 'replayer.prefs.v3';
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { return {}; }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        root: $('root').value, dte: $('dte').value, date: $('date').value,
        speedIdx: S.speedIdx, offset: S.offset, qty: S.qty, view: S.view, histDays: S.histDays,
        panes: S.panes.map((p) => [p.kind, p.iv]), paneInd: S.panes.map((p) => p.ind),
        layout: S.layout, jtab: S.jtab, show: S.show, zone: S.zone, jsort: S.jsort,
      }));
    } catch (e) { /* private mode: prefs are a convenience only */ }
  }
  // Uploaded trade files are kept (raw) across reloads and day changes and re-filtered to each
  // loaded session by /api/parse-trades. Browser storage is a convenience: if it is unavailable
  // or full, the files still last for this page.
  const UPLOADS_KEY = 'replayer.uploads.v1';
  function loadUploadFiles() {
    try { return JSON.parse(localStorage.getItem(UPLOADS_KEY)) || []; } catch (e) { return []; }
  }
  function saveUploadFiles() {
    try { localStorage.setItem(UPLOADS_KEY, JSON.stringify(S.uploadFiles)); return true; } catch (e) { return false; }
  }

  // ------------------------------------------------------------------ state
  const S = {
    data: null, meta: null, sessions: [], sessionSet: new Set(), byKey: new Map(),
    clock: 0, playing: false, speedIdx: 2, offset: 0, qty: 1,
    mode: 'blind',                       // always opens blind (operator preference)
    zone: { k: 1.5, lead: 0, big: 3 },    // n: next move beyond ±k σ (lead s early) or 2 s after a 1s candle >= big x the 5-min max range
    view: 'tv', histDays: 5, hist: { days: [] }, daily: [],
    ind: null, rowSize: 0.05, profileIdx: null, profile: null,
    sel: { key: '' }, panes: [],
    pos: null,                           // open practice position
    blindDate: false,                    // random-blind practice: the date is hidden everywhere
    journal: [], broker: [], uploads: [], uploadFiles: loadUploadFiles(), uploadsReq: 0, brokerNote: '', tradesVer: 0,
    jtab: 'practice', show: { practice: true, broker: true, upload: true },
    jsort: 'asc',                        // trades list by entry time: 'asc' oldest first | 'desc' newest first
    layout: { split: null, hudW: 330, journal: true, collapsed: {} },
  };
  const speed = () => E.SPEEDS[S.speedIdx];
  const esc = (x) => String(x).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  // ------------------------------------------------------------------ watch log
  // Records what was actually seen, for honest mock-trade analysis (trades.watch_*): BLIND spans
  // watched, split into PASSES at every discontinuity (rewind, forward jump, REVIEW, load), plus
  // jumps, REVIEW switches and SKIPs. Spans are flushed in pieces (same pass) every ~15 s and on
  // load / tab hide. A fill inside a span of an EARLIER pass = after_rewind (Engine.seenBefore).
  const W = { ready: false, loadId: '', pass: '', passN: 0, span: null, spans: [], skips: [],
    reviewed: false, pending: [], lastClock: null, jumped: false, jumpRule: null, lastFlush: 0 };
  const watchBase = () => ({ session_date: S.meta.session_date, root: S.meta.root, dte: S.meta.dte,
    blind_date: !!S.blindDate, load_id: W.loadId });
  function newPass() { W.pass = `${W.loadId}:${++W.passN}`; }
  function openSpan() {
    W.span = W.ready && S.mode === 'blind'
      ? { pass: W.pass, from: S.clock, to: S.clock, max: S.speedIdx, wall: new Date().toISOString() } : null;
  }
  function closeSpan() {
    const sp = W.span; W.span = null;
    if (!sp || !(sp.to > sp.from)) return;
    const ev = { kind: 'span', ...watchBase(), pass: sp.pass, from: Math.floor(sp.from), to: Math.floor(sp.to),
      max_speed: sp.max === E.SPEEDS.length - 1 ? 'max' : E.SPEEDS[sp.max], wall_from: sp.wall, wall_to: new Date().toISOString() };
    W.pending.push(ev); W.spans.push(ev);
  }
  function flushWatch(beacon) {
    W.lastFlush = performance.now();
    if (!W.pending.length) return;
    const events = W.pending.splice(0);
    if (beacon && navigator.sendBeacon) {
      navigator.sendBeacon('/api/watch', new Blob([JSON.stringify({ events })], { type: 'application/json' }));
      return;
    }
    postJson('/api/watch', { events }).catch((e) => {
      W.pending.unshift(...events);
      toast(`Watch log not saved (${e.message}); will retry`, 'err');
    });
  }
  function watchTick() {
    if (!W.ready) return;
    const prev = W.lastClock, now = S.clock, jumped = W.jumped, rule = W.jumpRule;
    W.lastClock = now; W.jumped = false; W.jumpRule = null;
    if (prev == null) return;
    if (now < prev || (jumped && now > prev)) {                 // discontinuity -> new pass
      if (W.span) { W.span.to = prev; closeSpan(); }
      W.pending.push({ kind: 'jump', ...watchBase(), from: Math.floor(prev), to: Math.floor(now), back: now < prev, mode: S.mode, ...(rule || {}) });
      newPass(); openSpan();
      return;
    }
    if (W.span && now > W.span.to) { W.span.to = now; W.span.max = Math.max(W.span.max, S.speedIdx); }
    if (performance.now() - W.lastFlush > 15000) {
      if (W.span && W.span.to > W.span.from) { closeSpan(); openSpan(); }  // same pass, next piece
      flushWatch(false);
    }
  }
  function watchEnd(beacon) {                                    // leaving the session (load / unload)
    if (!W.ready) return;
    if (W.span) { W.span.to = S.clock; closeSpan(); }
    flushWatch(beacon);
    W.ready = false;
  }
  async function watchStart() {                                  // after a session is loaded
    W.loadId = Math.random().toString(36).slice(2, 10); W.passN = 0; W.pending = [];
    W.lastClock = S.clock; W.jumped = false;
    let prior = [];
    try { prior = (await getJson(`/api/watch?date=${S.meta.session_date}&root=${S.meta.root}`)).events; }
    catch (e) { toast(`Watch log unavailable: ${e.message}`, 'err'); }
    W.spans = prior.filter((e) => e.kind === 'span');
    W.skips = prior.filter((e) => e.kind === 'skip');
    W.reviewed = prior.some((e) => e.kind === 'review');
    W.ready = true;
    newPass();
    W.pending.push({ kind: 'load', ...watchBase(), at: Math.floor(S.clock), mode: S.mode,
      prior_spans: W.spans.length, wall: new Date().toISOString() });
    if (S.mode === 'review') {                         // switched (e.g. deep link) before we were ready
      W.reviewed = true;
      W.pending.push({ kind: 'review', ...watchBase(), at: Math.floor(S.clock), wall: new Date().toISOString() });
    }
    openSpan();
    W.lastClock = S.clock;
    flushWatch(false);
    S.tradesVer++; renderJournal(true);
  }
  function watchMode(mode) {                                     // called by setMode on a real change
    if (!W.ready) return;
    if (mode === 'review') {
      if (W.span) { W.span.to = S.clock; closeSpan(); }
      W.reviewed = true;
      W.pending.push({ kind: 'review', ...watchBase(), at: Math.floor(S.clock), wall: new Date().toISOString() });
      flushWatch(false);
    } else { newPass(); openSpan(); }
  }
  window.addEventListener('pagehide', () => watchEnd(true));
  document.addEventListener('visibilitychange', () => {
    if (!W.ready) return;
    if (document.visibilityState === 'hidden') { if (W.span) { W.span.to = S.clock; closeSpan(); } flushWatch(true); }
    else openSpan();
  });
  const speedLabel = () => (S.speedIdx === E.SPEEDS.length - 1 ? 'Max' : `${speed()}×`);
  const f2 = (x) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(2));
  const money = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}$${Math.abs(x).toFixed(2)}`);
  const sgnCls = (x) => (x == null ? '' : x >= 0 ? 'pos' : 'neg');

  // ------------------------------------------------------------------ toasts
  function toast(msg, kind) {
    const el = document.createElement('div');
    el.className = `toast ${kind || ''}`;
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'err' ? 4500 : 3000);
  }

  // ------------------------------------------------------------------ chart theme
  const theme = {
    layout: { background: { type: 'solid', color: '#0f1115' }, textColor: '#c9d1d9' },
    grid: { vertLines: { color: '#1b2029' }, horzLines: { color: '#1b2029' } },
    rightPriceScale: { borderColor: '#262c36', minimumWidth: 70, scaleMargins: { top: 0.08, bottom: 0.2 } },
    timeScale: { borderColor: '#262c36', timeVisible: true, rightOffset: 8 },
    crosshair: { mode: LC.CrosshairMode.Normal },
    autoSize: true,
  };
  const lineOpts = (color, extra) => ({
    color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...extra,
  });

  // Volume-profile histograms drawn behind the candles (lightweight-charts series primitive).
  // profiles: [{rows:[{price,up,down,inVA}], max, rowSize, t0, t1, live}]
  //   prior day: drawn from its first bar, width ≤ 70% of that day's span
  //   live (today): anchored at today's first bar, or the pane's left edge once that scrolls off
  class ProfilePrimitive {
    constructor() {
      this.profiles = []; this.visible = true;
      this._view = { zOrder: () => 'bottom', renderer: () => ({ draw: (target) => this._draw(target) }) };
    }
    attached(p) { this._series = p.series; this._chart = p.chart; this._request = p.requestUpdate; }
    detached() { this._series = null; this._chart = null; this._request = null; }
    updateAllViews() {}
    paneViews() { return [this._view]; }
    set(profiles) { this.profiles = profiles || []; if (this._request) this._request(); }
    _draw(target) {
      const s = this._series, ch = this._chart;
      if (!s || !ch || !this.visible) return;
      const ts = ch.timeScale();
      target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
        const paneW = bitmapSize.width / hr;
        for (const d of this.profiles) {
          if (!d || !d.max) continue;
          let x0 = ts.timeToCoordinate(d.t0), maxW;
          if (d.live) {
            x0 = x0 == null || x0 < 0 ? 0 : x0;
            maxW = paneW * 0.22;
          } else {
            const x1 = ts.timeToCoordinate(d.t1);
            if (x0 == null || x1 == null || x1 <= x0 || x1 < 0 || x0 > paneW) continue;
            maxW = (x1 - x0) * 0.7;
          }
          for (const r of d.rows) {
            const y1 = s.priceToCoordinate(r.price + d.rowSize / 2), y2 = s.priceToCoordinate(r.price - d.rowSize / 2);
            if (y1 == null || y2 == null) continue;
            const top = Math.round(Math.min(y1, y2) * vr), h = Math.max(1, Math.round(Math.abs(y2 - y1) * vr) - 1);
            const wu = (r.up / d.max) * maxW * hr, wd = (r.down / d.max) * maxW * hr, x = Math.round(x0 * hr);
            ctx.fillStyle = r.inVA ? 'rgba(38,166,154,0.42)' : 'rgba(38,166,154,0.16)';
            ctx.fillRect(x, top, wu, h);
            ctx.fillStyle = r.inVA ? 'rgba(239,83,80,0.42)' : 'rgba(239,83,80,0.16)';
            ctx.fillRect(x + wu, top, wd, h);
          }
        }
      });
    }
  }

  // Entry→exit connectors: dashed line between the underlying prices at entry and exit, with the
  // trade's P&L in a tag at the exit end. A live (open) segment is dotted. Also draws the markers'
  // text (markers are set without text): lightweight-charts sizes marker text from the chart-wide
  // font, so smaller trade labels would shrink the axes too.
  const TRADE_FONT = 6;                 // px — half the library's 12
  const MARK_PX = 6;                    // px — trade arrow / dot size (half the library's 12 minimum)
  class ConnectorPrimitive {
    constructor() {
      this.segs = []; this.labels = [];
      this._view = { zOrder: () => 'top', renderer: () => ({ draw: (target) => this._draw(target) }) };
    }
    attached(p) { this._series = p.series; this._chart = p.chart; this._request = p.requestUpdate; }
    detached() { this._series = null; this._chart = null; this._request = null; }
    updateAllViews() {}
    paneViews() { return [this._view]; }
    set(segs, labels) {
      this.segs = segs || [];
      if (labels) this.labels = labels;
      if (this._request) this._request();
    }
    _draw(target) {
      const s = this._series, ch = this._chart;
      if (!s || !ch || (!this.segs.length && !this.labels.length)) return;
      this._drawLabels(target);
      const ts = ch.timeScale();
      target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
        for (const g of this.segs) {
          const x0 = ts.timeToCoordinate(g.t0), x1 = ts.timeToCoordinate(g.t1);
          const y0 = s.priceToCoordinate(g.p0), y1 = s.priceToCoordinate(g.p1);
          if (x0 == null || x1 == null || y0 == null || y1 == null) continue;
          ctx.save();
          ctx.strokeStyle = g.color; ctx.lineWidth = Math.max(1, 1.5 * hr);
          ctx.setLineDash(g.live ? [2 * hr, 3 * hr] : [6 * hr, 4 * hr]);
          ctx.beginPath(); ctx.moveTo(x0 * hr, y0 * vr); ctx.lineTo(x1 * hr, y1 * vr); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = g.color;
          for (const [x, y] of [[x0, y0], [x1, y1]]) { ctx.beginPath(); ctx.arc(x * hr, y * vr, 1.5 * hr, 0, 2 * Math.PI); ctx.fill(); }
          if (g.text) {
            ctx.font = `bold ${(TRADE_FONT - 0.5) * vr}px ui-monospace, Consolas, monospace`;
            const w = ctx.measureText(g.text).width + 4 * hr, h = 8 * vr;
            const bx = x1 * hr + 4 * hr, by = y1 * vr - h / 2;
            ctx.fillStyle = g.color; ctx.globalAlpha = 0.9;
            ctx.fillRect(bx, by, w, h);
            ctx.globalAlpha = 1; ctx.fillStyle = '#0f1115';
            ctx.textBaseline = 'middle'; ctx.fillText(g.text, bx + 2 * hr, by + h / 2);
          }
          ctx.restore();
        }
      });
    }
    // Trade markers, drawn here rather than by the library: its shapes have a 12 px minimum and its
    // text follows the chart-wide font (shrinking it would shrink the axes). Per bar and side, the
    // shapes stack outward from the bar's low (belowBar) / high (aboveBar) — or its value on line
    // series — and the bar's labels stack past the last shape.
    _drawLabels(target) {
      const s = this._series, ts = this._chart.timeScale();
      if (!this.labels.length) return;
      const A = MARK_PX, GAP = 2, step = A + GAP;
      const groups = new Map();
      for (const lb of this.labels) {
        const k = `${lb.time}|${lb.position}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(lb);
      }
      target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
        ctx.save();
        ctx.font = `${TRADE_FONT * vr}px ui-monospace, Consolas, monospace`;
        ctx.textAlign = 'center';
        for (const g of groups.values()) {
          const x = ts.timeToCoordinate(g[0].time);
          if (x == null) continue;
          const d = s.dataByIndex(Math.round(ts.coordinateToLogical(x)));
          if (!d) continue;
          const below = g[0].position === 'belowBar', dir = below ? 1 : -1;
          const price = d.low != null ? (below ? d.low : d.high) : d.value;
          const y0 = price == null ? null : s.priceToCoordinate(price);
          if (y0 == null) continue;
          g.forEach((lb, n) => {                                    // shapes
            const top = y0 + dir * (GAP + n * step), cy = top + dir * A / 2;
            ctx.fillStyle = lb.color;
            ctx.beginPath();
            if (lb.shape === 'circle') {
              ctx.arc(x * hr, cy * vr, (A / 2 - 0.5) * hr, 0, 2 * Math.PI);
            } else {                                               // arrow pointing at the bar
              const tip = top, base = top + dir * A * 0.55, end = top + dir * A, hw = A / 2, sw = A / 6;
              ctx.moveTo(x * hr, tip * vr);
              ctx.lineTo((x + hw) * hr, base * vr); ctx.lineTo((x + sw) * hr, base * vr);
              ctx.lineTo((x + sw) * hr, end * vr); ctx.lineTo((x - sw) * hr, end * vr);
              ctx.lineTo((x - sw) * hr, base * vr); ctx.lineTo((x - hw) * hr, base * vr);
              ctx.closePath();
            }
            ctx.fill();
          });
          let n = 0;
          for (const lb of g) {                                     // labels past the last shape
            if (!lb.text) continue;
            const y = y0 + dir * (GAP + g.length * step + n++ * (TRADE_FONT + 1));
            ctx.fillStyle = lb.color;
            ctx.textBaseline = below ? 'top' : 'bottom';
            ctx.fillText(lb.text, x * hr, y * vr);
          }
        }
        ctx.restore();
      });
    }
  }

  // Prior days bucketed to interval I: rows {time, date, ms, open, bar, vwap, sd, poc, vah, val, si}
  // plus one whitespace separator per day so lines (VWAP, bands, VA) break between sessions.
  function historyRows(days, I) {
    const rows = [];
    for (const d of days) {
      let cur = null;
      for (let i = 0; i < d.t.length; i++) {
        const b = Math.floor((d.t[i] - d.open_ms) / I);
        if (!cur || cur.b !== b) {
          if (cur) rows.push(cur);
          const ms = d.open_ms + b * I;
          cur = { b, ms, date: d.date, open: d.open_ms, close: d.close_ms, time: E.chartTime(d.date, ms),
            bar: { open: d.o[i], high: d.h[i], low: d.l[i], close: d.c[i], volume: d.v[i], n: d.n ? d.n[i] : 0 } };
        } else {
          cur.bar.high = Math.max(cur.bar.high, d.h[i]); cur.bar.low = Math.min(cur.bar.low, d.l[i]);
          cur.bar.close = d.c[i]; cur.bar.volume += d.v[i]; cur.bar.n += d.n ? d.n[i] : 0;
        }
        Object.assign(cur, { vwap: d.vwap[i], sd: d.sd[i], poc: d.poc[i], vah: d.vah[i], val: d.val[i] });
      }
      if (cur) rows.push(cur);
      rows.push({ sep: true, time: E.chartTime(d.date, d.close_ms) });
    }
    let si = 0;
    for (const r of rows) if (!r.sep) r.si = si++;
    return rows;
  }

  function historyProfiles(days, rowSize) {
    return days.map((d) => {
      const [val, vah] = d.profile.va;
      let max = 0;
      const rows = d.profile.rows.map(([price, up, down]) => {
        if (up + down > max) max = up + down;
        return { price, up, down, inVA: price >= val - 1e-9 && price <= vah + 1e-9 };
      });
      return { rows, max, rowSize, t0: E.chartTime(d.date, d.t[0]), t1: E.chartTime(d.date, d.t[d.t.length - 1]) };
    });
  }

  // A SOURCE close sequence for multi-timeframe EMA/BB: prior-day bars (if the source is 1m+)
  // then today's source buckets. idxAt(...) maps a display instant to its source bar index.
  function mtfSource(Isrc) {
    const c = S.data.chart, m = S.meta;
    const sb = E.buildBuckets(c.t, m.open_ms, m.close_ms, Isrc);
    const sbars = E.fullOhlcv(c, sb);
    const hrows = Isrc >= HIST_MIN_IV ? historyRows(S.hist.days, Isrc).filter((r) => !r.sep) : [];
    const key = new Map(hrows.map((r, i) => [`${r.date}|${r.ms}`, i]));
    const closes = hrows.map((r) => r.bar.close).concat(sbars.map((x) => (x ? x.close : null)));
    const Hs = hrows.length;
    return {
      closes,
      todayIdx: (e) => Hs + Math.max(0, Math.min(sb.n - 1, Math.floor((e - m.open_ms) / Isrc))),
      histIdx: (r, e) => key.get(`${r.date}|${r.open + Math.floor((e - r.open) / Isrc) * Isrc}`),
    };
  }

  // 1D source: prior daily closes (server: strictly before the session) then today, whose
  // developing close is the price as of the display instant. A prior history day's index is
  // its own daily bar, developing intraday the same way.
  function dailySource() {
    const closes = S.daily.map((d) => d.c), idx = new Map(S.daily.map((d, i) => [d.date, i]));
    return { closes, todayIdx: () => closes.length, histIdx: (r) => idx.get(r.date) };
  }

  // ------------------------------------------------------------------ panes
  let syncing = false, syncingCross = false;

  class Pane {
    constructor(i) {
      this.i = i; this.box = $(`pane${i}`); this.host = $(`chart${i}`); this.legendEl = $(`legend${i}`);
      this.srcSel = $(`src${i}`); this.ivSel = $(`iv${i}`); this.indEl = $(`ind${i}`);
      this.kind = 'chart'; this.iv = '1m'; this.ind = defaultInd();
      this.chart = null; this.layers = []; this.profile = null; this.hrows = []; this.lock = null;
      this.hover = false; this.markerKey = '';
      this.R = { clock: null, k: -1, mode: '', sel: '', full: true, fresh: true };
      this.w = 0;                          // window start: rows [0, w) of history+today are not in the series
      this.following = true; this.dragging = false; this.axisPress = false;
      this.bindAxisZoom();
      this.bindPan();
    }

    configure(kind, iv) {
      this.kind = kind; this.iv = iv;
      this.srcSel.value = kind; this.ivSel.value = iv;
      this.box.classList.toggle('hidden', kind === 'none');
      applySplit();
      this.drawChips();
      this.rebuild();
    }

    destroy() {
      if (this.chart) this.chart.remove();
      this.chart = null; this.layers = []; this.profile = null; this.hrows = []; this.main = null;
    }

    // ---- per-pane indicator chips (EMA / BB carry length + source timeframe)
    drawChips() {
      const el = this.indEl;
      el.innerHTML = '';
      if (this.kind !== 'chart') return;
      const I = this.ind;
      const chip = (label, on, title, onClick) => {
        const b = document.createElement('button');
        b.className = `chip${on ? ' on' : ''}`; b.textContent = label; b.title = title;
        b.onclick = (ev) => { ev.target.blur(); onClick(); this.indChanged(); };
        el.appendChild(b);
      };
      const cfg = (o, fields) => {
        const span = document.createElement('span');
        span.className = 'cfg';
        for (const [k, kind, title] of fields) {
          let inp;
          if (kind === 'tf') {
            inp = document.createElement('select');
            for (const tf of TF_CHOICES) inp.add(new Option(tf === 'chart' ? 'chart' : tf, tf));
          } else {
            inp = document.createElement('input');
            inp.type = 'number'; inp.min = kind === 'mult' ? '0.5' : '2'; inp.step = kind === 'mult' ? '0.1' : '1';
          }
          inp.value = o[k]; inp.title = title;
          inp.onchange = () => {
            const v = kind === 'tf' ? inp.value : Number(inp.value);
            if (kind !== 'tf' && !(v > 0)) { inp.value = o[k]; return; }
            o[k] = kind === 'len' ? Math.max(2, Math.round(v)) : v;
            inp.blur(); this.indChanged();
          };
          span.appendChild(inp);
        }
        el.appendChild(span);
      };
      chip('VWAP', I.vwap, 'Session VWAP', () => { I.vwap = !I.vwap; });
      chip('σ', I.bands, 'VWAP ±1.8/2/2.2/2.5/3σ bands', () => { I.bands = !I.bands; });
      chip('VP', I.vp, 'Volume profile + developing POC/VAH/VAL', () => { I.vp = !I.vp; });
      chip('Vol', I.vol, 'Volume bars', () => { I.vol = !I.vol; });
      chip('Tape', I.tape, 'Tape speed: number of trades per bar (above volume)', () => { I.tape = !I.tape; });
      chip('EMA', I.ema.on, 'EMA — length and source timeframe', () => { I.ema.on = !I.ema.on; });
      if (I.ema.on) cfg(I.ema, [['len', 'len', 'EMA length (bars of the source timeframe)'], ['tf', 'tf', 'Source timeframe']]);
      chip('BB', I.bb.on, 'Bollinger — SMA length, σ multiple, source timeframe', () => { I.bb.on = !I.bb.on; });
      if (I.bb.on) cfg(I.bb, [['len', 'len', 'SMA length (bars of the source timeframe)'], ['mult', 'mult', 'σ multiple'], ['tf', 'tf', 'Source timeframe']]);
    }

    indChanged() {
      savePrefs();
      this.drawChips();
      // Visibility-only toggles are cheap; EMA/BB parameter changes need fresh series data.
      this.rebuild();
    }

    rebuild() {
      const keepRange = this.chart && !this.R.fresh ? this.chart.timeScale().getVisibleLogicalRange() : null;
      this.destroy();
      this.R.full = true; this.R.fresh = !keepRange; this.markerKey = '';
      this.keepRange = keepRange; this.keepW = keepRange ? this.w : null; this.w = 0;
      if (this.kind === 'none' || !S.data) return;
      const m = S.meta, I = E.INTERVALS[this.iv];
      const srcT = this.kind === 'chart' ? S.data.chart.t : S.data.underlying.t;
      this.b = E.buildBuckets(srcT, m.open_ms, m.close_ms, I);
      this.times = this.b.starts.map((ms) => E.chartTime(m.session_date, ms));
      this.hrows = this.kind === 'chart' && I >= HIST_MIN_IV ? historyRows(S.hist.days, I) : [];
      this.chart = LC.createChart(this.host, {
        ...theme,
        localization: { timeFormatter: (t) => fmtChartTime(t, I < 60000) },
        // We manage the view ourselves (follow mode); the library's auto-shift would march bars left.
        timeScale: { ...theme.timeScale, secondsVisible: I < 60000, barSpacing: I === 1000 ? 3 : 6, minBarSpacing: 0.3,
          shiftVisibleRangeOnNewBar: false, tickMarkFormatter: tickMark },
      });
      // Panes at the same interval follow each other by TIME (history may differ per pane).
      this.chart.timeScale().subscribeVisibleTimeRangeChange((r) => {
        if (syncing || !r) return;
        const other = S.panes[1 - this.i];
        if (!other.chart || other.iv !== this.iv) return;
        syncing = true;
        try { other.chart.timeScale().setVisibleRange(r); } catch (e) { /* range outside other's data */ }
        syncing = false;
      });
      this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
        if (r && this.w > 0 && r.from < 20 && !this.growing) { this.growing = true; this.R.full = true; }
      });
      this.chart.subscribeCrosshairMove((p) => this.onCrosshair(p));
      if (this.kind === 'chart') this.buildChart();
      else if (this.kind === 'underlying') this.buildUnderlying();
      else this.buildOptions();
      this.conn = null;
      if (this.kind !== 'options') { this.conn = new ConnectorPrimitive(); this.main.attachPrimitive(this.conn); }
      for (const L of this.layers) {
        const h = L.hist;
        L.histData = h ? this.hrows.map((r) => (r.sep ? { time: r.time } : withTime(r.time, h(r)))) : [];
      }
      this.applyZoomProviders();
      S.profileIdx = null;                                   // re-push profiles to new primitives
    }

    candleSeries() {
      return this.chart.addCandlestickSeries({
        upColor: COLORS.up, downColor: COLORS.down, wickUpColor: COLORS.up, wickDownColor: COLORS.down, borderVisible: false,
      });
    }

    buildChart() {
      const c = S.data.chart, b = this.b, ind = S.ind, IND = this.ind, Idisp = E.INTERVALS[this.iv];
      const bars = E.fullOhlcv(c, b);
      const closes = (arr) => E.bucketCloseValues(c.t, arr, b);
      const asOf = (arr) => E.valueAsOf(c.t, arr, S.clock);
      const vw = closes(ind.vwap), sd = closes(ind.sd);
      const val = (v) => (v == null ? null : { value: v });
      const partialBar = (k) => E.ohlcvAsOf(c, b, k, S.clock);
      const ohlc = (x) => x && { open: x.open, high: x.high, low: x.low, close: x.close };
      const volItem = (x) => x && { value: x.volume, color: x.close >= x.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)' };

      const candles = this.candleSeries();
      this.main = candles;
      this.layers = [{ series: candles, full: (j) => ohlc(bars[j]), partial: (k) => ohlc(partialBar(k)), hist: (r) => ohlc(r.bar), key: 'bar' }];
      if (IND.vol) {
        const vol = this.chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
        this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 }, visible: false });
        this.layers.push({ series: vol, full: (j) => volItem(bars[j]), partial: (k) => volItem(partialBar(k)), hist: (r) => volItem(r.bar), key: 'vol' });
      }
      if (IND.tape) {
        // trades per bar — the tape's tempo; sits just above the volume bars on its own scale
        const tape = this.chart.addHistogramSeries({ priceScaleId: 'tape', color: 'rgba(230,194,41,0.5)', lastValueVisible: false, priceLineVisible: false,
          priceFormat: { type: 'volume' } });
        this.chart.priceScale('tape').applyOptions({ scaleMargins: { top: 0.7, bottom: 0.16 }, visible: false });
        const tItem = (x) => x && { value: x.n };
        this.layers.push({ series: tape, full: (j) => tItem(bars[j]), partial: (k) => tItem(partialBar(k)), hist: (r) => tItem(r.bar), key: 'tape' });
      }
      if (IND.vwap) {
        this.layers.push({ series: this.chart.addLineSeries(lineOpts(COLORS.vwap, { lineWidth: 2, title: 'VWAP', lastValueVisible: true })),
          full: (j) => val(vw[j]), partial: () => val(asOf(ind.vwap)), hist: (r) => val(r.vwap), key: 'vwap' });
      }
      if (IND.bands) {
        const zk = S.zone.k, ks = BANDS.includes(zk) ? BANDS : [zk, ...BANDS];
        for (const k of ks) {
          for (const sign of [1, -1]) {
            const s = this.chart.addLineSeries(lineOpts(k === 2 ? COLORS.band2 : COLORS.band,
              k === zk && !BANDS.includes(zk) ? { lineStyle: LC.LineStyle.Dashed } : undefined));
            this.layers.push({
              series: s, overlay: true,
              full: (j) => (vw[j] == null ? null : { value: vw[j] + sign * k * sd[j] }),
              partial: () => { const v = asOf(ind.vwap); return v == null ? null : { value: v + sign * k * asOf(ind.sd) }; },
              hist: (r) => ({ value: r.vwap + sign * k * r.sd }),
            });
          }
        }
      }
      if (IND.vp) {
        for (const [key, color, title] of [['poc', COLORS.poc, 'POC'], ['vah', COLORS.va, 'VAH'], ['val', COLORS.va, 'VAL']]) {
          const arr = ind[key];
          const s = this.chart.addLineSeries(lineOpts(color, { lineType: LC.LineType.WithSteps, title, lastValueVisible: true }));
          const cl = closes(arr);
          this.layers.push({ series: s, overlay: true, full: (j) => val(cl[j]), partial: () => val(asOf(arr)), hist: (r) => val(r[key]), key });
        }
        this.profile = new ProfilePrimitive();
        candles.attachPrimitive(this.profile);
        this.histProfiles = this.hrows.length ? historyProfiles(S.hist.days, S.rowSize) : [];
      }

      // Multi-timeframe EMA / BB: value at a display bar's end (or at the clock for the bar in
      // progress) = completed source closes before that instant + the price as of that instant.
      const srcOf = (tf) => (tf === '1D' ? dailySource() : mtfSource(tf === 'chart' ? Idisp : TF_MS[tf]));
      const endOf = (j) => Math.min(this.b.starts[j] + Idisp - 1, S.meta.close_ms);
      const histEnd = (r) => Math.min(r.ms + Idisp - 1, r.close - 1);
      if (IND.ema.on) {
        const src = srcOf(IND.ema.tf), st = E.emaSeries(src.closes, IND.ema.len), L = IND.ema.len;
        const full = bars.map((x, j) => (x ? E.mtfEMA(src.closes, st, src.todayIdx(endOf(j)), x.close, L) : null));
        this.layers.push({
          series: this.chart.addLineSeries(lineOpts(COLORS.ema, { title: `EMA${L}${IND.ema.tf === 'chart' ? '' : ' ' + IND.ema.tf}`, lastValueVisible: true })),
          full: (j) => val(full[j]),
          partial: (k) => { const x = partialBar(k); return x ? val(E.mtfEMA(src.closes, st, src.todayIdx(S.clock), x.close, L)) : null; },
          hist: (r) => val(E.mtfEMA(src.closes, st, src.histIdx(r, histEnd(r)), r.bar.close, L)),
          key: 'ema',
        });
      }
      if (IND.bb.on) {
        const src = srcOf(IND.bb.tf), L = IND.bb.len, M = IND.bb.mult;
        const full = bars.map((x, j) => (x ? E.mtfBB(src.closes, src.todayIdx(endOf(j)), x.close, L, M) : null));
        const live = (k) => { const x = partialBar(k); return x ? E.mtfBB(src.closes, src.todayIdx(S.clock), x.close, L, M) : null; };
        for (const [key, color, style] of [['up', COLORS.bb, 0], ['mid', COLORS.bbMid, 2], ['lo', COLORS.bb, 0]]) {
          this.layers.push({
            series: this.chart.addLineSeries(lineOpts(color, { lineStyle: style })), overlay: true,
            full: (j) => (full[j] ? { value: full[j][key] } : null),
            partial: (k) => { const x = live(k); return x ? { value: x[key] } : null; },
            hist: (r) => { const x = E.mtfBB(src.closes, src.histIdx(r, histEnd(r)), r.bar.close, L, M); return x ? { value: x[key] } : null; },
            key: `bb_${key}`,
          });
        }
      }
    }

    buildUnderlying() {
      const u = S.data.underlying, b = this.b;
      const bars = E.fullBars(u.p, b);
      this.main = this.candleSeries();
      this.layers = [{ series: this.main, full: (j) => bars[j], partial: (k) => E.barAsOf(u.t, u.p, b, k, S.clock), key: 'bar' }];
    }

    buildOptions() {
      this.callLine = this.chart.addLineSeries(lineOpts(COLORS.call, { lineWidth: 2, title: 'C mid', lastValueVisible: true }));
      this.putLine = this.chart.addLineSeries(lineOpts(COLORS.put, { lineWidth: 2, title: 'P mid', lastValueVisible: true }));
      this.main = this.callLine;
      this.optCache = new Map();
      this.setOptionLayers();
    }

    setOptionLayers() {
      const layer = (series, osi, key) => {
        if (!osi) return { series, full: () => null, partial: () => null, key, histData: [] };
        if (!this.optCache.has(osi)) {
          const c = S.data.contracts[osi];
          this.optCache.set(osi, E.bucketCloseValues(c.t, c.mid, this.b));
        }
        const cl = this.optCache.get(osi), c = S.data.contracts[osi];
        return {
          series, key, histData: [],
          full: (j) => (cl[j] == null ? null : { value: cl[j] }),
          partial: () => { const v = E.valueAsOf(c.t, c.mid, S.clock); return v == null ? null : { value: v }; },
        };
      };
      this.layers = [layer(this.callLine, S.sel.C, 'call'), layer(this.putLine, S.sel.P, 'put')];
    }

    // ---- price-axis zoom: wheel over the right axis scales price around the auto range
    applyZoomProviders() {
      for (const L of this.layers) {
        if (L.series === this.main) {
          L.series.applyOptions({
            autoscaleInfoProvider: (orig) => {
              if (!this.lock) return orig();
              const r = orig();
              return { ...(r || {}), priceRange: { minValue: this.lock.lo, maxValue: this.lock.hi } };
            },
          });
        } else if (!['vol', 'tape'].includes(L.series.options().priceScaleId)) {
          // overlays never stretch the scale; VWAP/EMA count only while auto
          L.series.applyOptions({ autoscaleInfoProvider: (orig) => (L.overlay || this.lock ? null : orig()) });
        }
      }
    }
    // ---- TradingView-style price scale.
    // AUTO (default): price follows the data; dragging the chart pans time only.
    // UNLOCKED: scrolling (or dragging) on the price axis freezes the range — wheel zooms around the
    //   price under the cursor; dragging the chart then moves it freely up/down as well as
    //   sideways; playback no longer rescales. "A" or double-clicking the axis re-locks to auto.
    // The unlocked range is served through the main series' autoscaleInfoProvider (`this.lock`,
    // other series report nothing), because lightweight-charts 4.2 has no public price-range
    // setter. A native axis drag also unlocks (the library's own manual mode) — both show "A".
    // While the operator drags, the replay never moves the view; on release follow mode stays off
    // if the newest bar is out of view (⟫ resumes).
    bindPan() {
      const wrap = this.host.parentElement;
      const mk = (cls, text, title, onClick) => {
        const b = document.createElement('button');
        b.className = `paneBtn ${cls} hidden`; b.textContent = text; b.title = title;
        b.onclick = (ev) => { ev.stopPropagation(); ev.target.blur(); onClick(); };
        wrap.appendChild(b);
        return b;
      };
      this.liveBtn = mk('live', '⟫', 'Scroll to the newest bar and follow it', () => this.goLive());
      this.autoBtn = mk('auto', 'A', 'Auto-scale price (double-click the price axis also resets)', () => this.autoScale());
      this.host.addEventListener('pointerdown', (ev) => {
        if (!this.chart || ev.button !== 0) return;
        if (this.onAxis(ev)) { this.axisPress = true; return; }
        this.dragging = true; this.dragY = ev.clientY;
      }, { capture: true });
      window.addEventListener('pointermove', (ev) => {
        if (!this.dragging || !this.chart || !this.lock) return;
        const dy = ev.clientY - this.dragY;                     // unlocked: pan price with the drag
        this.dragY = ev.clientY;
        if (!dy) return;
        const ppx = this.pricePerPixel(this.lock);
        if (ppx) this.setLock({ lo: this.lock.lo + dy * ppx, hi: this.lock.hi + dy * ppx });
      });
      window.addEventListener('pointerup', () => {
        if (this.axisPress) {                                     // native axis drag unlocks too
          this.axisPress = false;
          if (this.chart && !this.chart.priceScale('right').options().autoScale) this.autoBtn.classList.remove('hidden');
        }
        if (!this.dragging) return;
        this.dragging = false;
        this.checkFollow();
      });
      this.host.addEventListener('wheel', () => setTimeout(() => this.checkFollow(), 0), { passive: true });
    }
    onAxis(ev) {
      if (!this.chart) return false;
      const rect = this.host.getBoundingClientRect();
      return ev.clientX > rect.right - this.chart.priceScale('right').width();
    }
    paneHeight() { return this.host.clientHeight - this.chart.timeScale().height(); }
    // The data range [lo, hi] maps to the pane between the scale margins, so these invert exactly.
    visiblePriceRange() {
      const H = this.paneHeight(), m = this.chart.priceScale('right').options().scaleMargins;
      const hi = this.main.coordinateToPrice(H * m.top), lo = this.main.coordinateToPrice(H * (1 - m.bottom));
      return lo == null || hi == null || !(hi > lo) ? null : { lo, hi };
    }
    pricePerPixel(r) {
      const H = this.paneHeight(), m = this.chart.priceScale('right').options().scaleMargins;
      const px = H * (1 - m.top - m.bottom);
      return px > 0 ? (r.hi - r.lo) / px : null;
    }
    setLock(r) {
      this.lock = r;
      this.chart.priceScale('right').applyOptions({ autoScale: true });   // our provider drives it
      this.applyZoomProviders();
      this.autoBtn.classList.toggle('hidden', !r);
    }
    off() { return this.hrows.length - this.w; }           // logical index of today's bar 0
    lastIndex() { return this.off() + Math.max(0, E.bucketOf(this.b, S.clock)); }
    checkFollow() {
      if (!this.chart) return;
      const r = this.chart.timeScale().getVisibleLogicalRange(), last = this.lastIndex();
      this.following = !!r && last >= r.from - 1 && last <= r.to + 1;
      this.liveBtn.classList.toggle('hidden', this.following || S.mode === 'review');
    }
    // Scroll the view to [t0, t1] (session ms) at the CURRENT zoom — no clock change. Centres on
    // the middle when the span fits, else on t0. If the sliding window trimmed those rows away,
    // grow it first (render applies wantW, then re-runs the pan).
    panTo(t0, t1) {
      if (!this.chart || !this.b) return;
      const I = E.INTERVALS[this.iv], m = S.meta;
      const kOf = (ms) => Math.max(0, Math.min(this.b.n - 1, Math.floor((ms - m.open_ms) / I)));
      const ts = this.chart.timeScale(), r = ts.getVisibleLogicalRange(), w = r ? r.to - r.from : 120;
      const k0 = kOf(t0), k1 = t1 != null ? kOf(t1) : k0;
      const k = k1 - k0 < 0.8 * w ? (k0 + k1) / 2 : k0;
      const idx = this.off() + k;
      this.following = false;
      if (idx - w / 2 < 0 && this.w > 0) {
        this.wantW = Math.max(0, this.w + Math.floor(idx - w / 2) - 20);
        this.pendingPan = [t0, t1]; this.R.full = true;
        return;
      }
      const nr = { from: idx - w / 2, to: idx + w / 2 };
      ts.setVisibleLogicalRange(nr);
      // right after a setData the library still reports the old range, so judge "following" on nr
      const last = this.lastIndex();
      this.following = last >= nr.from - 1 && last <= nr.to + 1;
      this.liveBtn.classList.toggle('hidden', this.following || S.mode === 'review');
    }
    // Bring price p into view at the CURRENT vertical zoom: lock the scale to the same height,
    // centred on p — unless it's already locked with p comfortably inside. (Options panes skip.)
    showPrice(p) {
      if (!this.chart || !this.main || p == null || this.kind === 'options') return;
      const r = this.lock || this.visiblePriceRange();
      if (!r) return;
      const h = r.hi - r.lo;
      if (this.lock && p > r.lo + 0.1 * h && p < r.hi - 0.1 * h) return;
      this.setLock({ lo: p - h / 2, hi: p + h / 2 });
    }
    priceAt(ms) {
      const src = this.kind === 'chart' ? [S.data.chart.t, S.data.chart.c] : [S.data.underlying.t, S.data.underlying.p];
      return E.valueAsOf(src[0], src[1], ms);
    }
    goLive() {
      if (!this.chart) return;
      const ts = this.chart.timeScale(), r = ts.getVisibleLogicalRange(), last = this.lastIndex();
      const w = r ? r.to - r.from : 120;
      ts.setVisibleLogicalRange({ from: last - 0.8 * w, to: last + 0.2 * w });
      this.following = true;
      this.liveBtn.classList.add('hidden');
    }
    autoScale() {
      if (!this.chart) return;
      this.setLock(null);
    }

    bindAxisZoom() {
      this.host.addEventListener('wheel', (ev) => {
        if (!this.onAxis(ev) || !this.main) return;
        ev.preventDefault(); ev.stopPropagation();
        const r = this.lock || this.visiblePriceRange();          // first scroll: freeze where it is
        if (!r) return;
        const y = ev.clientY - this.host.getBoundingClientRect().top;
        let p = this.main.coordinateToPrice(y);
        if (p == null || p < r.lo || p > r.hi) p = (r.lo + r.hi) / 2;
        const f = ev.deltaY > 0 ? 1.1 : 1 / 1.1;                   // wheel up = zoom in
        if ((r.hi - r.lo) * f < 1e-4) return;
        this.setLock({ lo: p - (p - r.lo) * f, hi: p + (r.hi - p) * f });
      }, { capture: true, passive: false });
      this.host.addEventListener('dblclick', (ev) => {
        if (this.onAxis(ev)) this.setLock(null);
      }, { capture: true });
    }

    setProfile(today) {
      if (!this.profile) return;
      const live = today && { ...today, t0: this.times[0], live: true };
      this.profile.set((this.histProfiles || []).concat(live ? [live] : []));
    }

    // ---- legend (TradingView-style) + crosshair sync
    onCrosshair(p) {
      this.hover = !!(p && p.time && p.point);
      this.drawLegend(this.hover ? p.seriesData : null);
      if (syncingCross) return;
      const other = S.panes[1 - this.i];
      if (!other.chart || !other.main) return;
      syncingCross = true;
      try {
        if (!this.hover) other.chart.clearCrosshairPosition();
        else {
          const t = other.mapTime(p.time);
          const price = this.main ? this.main.coordinateToPrice(p.point.y) : null;
          if (t != null && price != null) other.chart.setCrosshairPosition(price, t, other.main);
        }
      } catch (e) { /* time not on the other pane */ }
      syncingCross = false;
    }
    // A chart time from another pane -> this pane's bar time containing it (today only, or history).
    mapTime(time) {
      const I = E.INTERVALS[this.iv] / 1000;
      const dayBase = Math.floor(time / 86400) * 86400;
      const date = new Date(dayBase * 1000).toISOString().slice(0, 10);
      const open = date === S.meta.session_date ? S.meta.open_ms / 1000
        : (S.hist.days.find((d) => d.date === date) || { open_ms: 34200000 }).open_ms / 1000;
      const sec = time - dayBase;
      if (sec < open) return null;
      return dayBase + open + Math.floor((sec - open) / I) * I;
    }
    drawLegend(seriesData) {
      if (!this.chart || !S.data) { this.legendEl.innerHTML = ''; return; }
      const get = (key) => {
        const L = this.layers.find((x) => x.key === key);
        if (!L) return null;
        if (seriesData) return seriesData.get(L.series) || null;
        const k = E.bucketOf(this.b, S.clock);
        return S.mode === 'review' ? L.full(k) : L.partial(k);
      };
      const n = (x) => (x == null ? '—' : x.toFixed(2));
      if (this.kind === 'options') {
        const c = get('call'), p = get('put');
        this.legendEl.innerHTML = `<span class="sym">C ${S.sel.kc ?? ''} / P ${S.sel.kp ?? ''}</span>` +
          `<span class="u">C ${n(c && c.value)}</span> <span class="d">P ${n(p && p.value)}</span>`;
        return;
      }
      const sym = this.kind === 'chart' ? S.data.chart.symbol : (S.meta.root === 'SPXW' ? 'SPX' : S.meta.root);
      const bar = get('bar');
      let h = `<span class="sym">${sym} · ${this.iv}</span>`;
      if (bar && bar.open != null) {
        const cls = bar.close >= bar.open ? 'u' : 'd';
        h += `O <span class="${cls}">${n(bar.open)}</span> H <span class="${cls}">${n(bar.high)}</span> ` +
             `L <span class="${cls}">${n(bar.low)}</span> C <span class="${cls}">${n(bar.close)}</span>`;
      }
      const tp = get('tape');
      const vol = get('vol');
      if (vol && vol.value != null) h += `  V ${(vol.value / 1000).toFixed(1)}K`;
      if (tp && tp.value != null) h += `  <span class="poc">T ${tp.value}</span>`;
      const vw = get('vwap');
      if (vw && vw.value != null) h += `  <span class="vw">VWAP ${n(vw.value)}</span>`;
      const em = get('ema');
      if (em && em.value != null) h += `  <span class="em">EMA ${n(em.value)}</span>`;
      const bu = get('bb_up'), bl = get('bb_lo');
      if (bu && bl && bu.value != null) h += `  <span class="bbv">BB ${n(bl.value)}–${n(bu.value)}</span>`;
      const poc = get('poc');
      if (poc && poc.value != null) h += `  <span class="poc">POC ${n(poc.value)}</span>`;
      this.legendEl.innerHTML = h;
    }

    // ---- trade markers (practice / real / uploaded), revealed with the clock in BLIND
    updateMarkers(k) {
      if (!this.main || this.kind === 'options') return;
      const reveal = S.mode === 'review';
      const sets = tradeSets();
      const revealed = reveal ? -1 : sets.reduce((a, s) => a + s.trades.filter((t) => t.entry_t != null && t.entry_t <= S.clock).length
        + s.trades.filter((t) => t.exit_t != null && t.exit_t <= S.clock).length, 0);
      const key = `${S.mode}|${this.w}|${revealed}|${W.skips.filter((x) => reveal || x.t <= S.clock).length}|${S.tradesVer}|${reveal ? k : ''}|${S.pos ? S.pos.entry_t + ':' + S.pos.fills.length : ''}`;
      const m = S.meta, I = E.INTERVALS[this.iv];
      const timeOf = (ms) => E.chartTime(m.session_date, m.open_ms + Math.max(0, Math.min(this.b.n - 1, Math.floor((ms - m.open_ms) / I))) * I);
      const priceAt = this.kind === 'chart'
        ? (ms) => E.valueAsOf(S.data.chart.t, S.data.chart.c, ms) ?? S.data.chart.o[0]
        : (ms) => E.valueAsOf(S.data.underlying.t, S.data.underlying.p, ms) ?? S.data.underlying.p[0];
      // live segment of an open practice position: entry → now, unrealized P&L
      let live = null;
      if (S.pos && S.pos.entry_t <= S.clock) {
        const q = quoteNow(S.pos.osi);
        const pnl = q ? E.optionPnl(S.pos.entry_mid, q.bid, S.pos.qty) : null;
        live = { t0: timeOf(S.pos.entry_t), p0: priceAt(S.pos.entry_t), t1: timeOf(S.clock), p1: priceAt(S.clock), live: true,
          color: pnl == null ? '#58a6ff' : pnl >= 0 ? '#3fb950' : '#f85149', text: pnl == null ? '' : `${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(0)}` };
      }
      if (key === this.markerKey) { if (live && this.conn) this.conn.set(this.segs.concat([live])); return; }
      this.markerKey = key;
      this.segs = [];
      for (const s of sets) this.segs = this.segs.concat(E.tradeConnectors(s.trades, S.clock, reveal, timeOf, priceAt, MARKER_STYLE[s.kind]));
      let marks = [];
      for (const s of sets) marks = marks.concat(E.tradeMarkers(s.trades, S.clock, reveal, timeOf, MARKER_STYLE[s.kind]));
      if (S.pos) {
        S.pos.fills.forEach((f, i) => {
          if (f.t > S.clock) return;
          marks.push({ time: timeOf(f.t), position: 'belowBar', shape: 'arrowUp', color: '#58a6ff',
            text: i ? `+${f.qty} @${f.mid.toFixed(2)}` : `${S.pos.type}${S.pos.strike} ×${f.qty} @${f.mid.toFixed(2)}` });
        });
      }
      if (S.show.practice) {
        for (const sk of W.skips) {
          if (reveal || sk.t <= S.clock) marks.push({ time: timeOf(sk.t), position: 'aboveBar', shape: 'circle', color: '#8b949e', text: 'skip' });
        }
      }
      if (reveal) marks.push({ time: this.times[k], position: 'aboveBar', color: '#d29922', shape: 'circle', text: 'now' });
      // a marker before the window's first bar would be pinned to that bar by the library
      const first = this.w > this.hrows.length ? this.times[this.w - this.hrows.length] : -Infinity;
      marks = marks.filter((mk) => mk.time >= first).sort((a, b) => a.time - b.time);
      // text is drawn small by the connector primitive (TRADE_FONT); the library draws the shapes
      // shapes + text are drawn small by the connector primitive (MARK_PX / TRADE_FONT)
      if (this.conn) this.conn.set(live ? this.segs.concat([live]) : this.segs, marks);
      else this.main.setMarkers(marks);
    }

    // First view after a (re)build, anchored on the clock's bar k. No history -> that bar
    // mid-pane (at the open: the first bar centred); with history -> today's open near the left
    // edge so the day plays out rightward, unless the clock's bar would be off-screen.
    initialView(k) {
      const ts = this.chart.timeScale(), H = this.off(), last = H + Math.max(0, k);
      const n = Math.max(20, Math.floor(ts.width() / (E.INTERVALS[this.iv] === 1000 ? 3 : 6)));
      if (S.mode === 'review') {
        const total = H + this.times.length;
        if (H && this.times.length + 10 <= ts.width() / 0.5) ts.setVisibleLogicalRange({ from: H - 5, to: total + 5 });
        else if (!H && total <= ts.width() / 0.5) ts.fitContent();
        else ts.setVisibleLogicalRange({ from: last - n / 2, to: last + n / 2 });
      } else if (H) {
        let from = H - 8;
        if (last > from + n - 3) from = last - 0.8 * n;
        ts.setVisibleLogicalRange({ from, to: from + n });
      } else {
        ts.setVisibleLogicalRange({ from: last - n / 2, to: last + n / 2 });
      }
    }

    // Follow the newest bar while the operator is watching it: once it reaches the right edge,
    // slide the window. If they've scrolled away (e.g. studying history), leave the view alone.
    follow(prevRange, prevLast, last) {
      if (!prevRange || this.dragging || !this.following) return;
      const ts = this.chart.timeScale(), w = prevRange.to - prevRange.from;
      if (last > prevRange.to - 3) ts.setVisibleLogicalRange({ from: last + 3 - w, to: last + 3 });
      else if (last < prevRange.from) ts.setVisibleLogicalRange({ from: last - 0.8 * w, to: last + 0.2 * w });
    }

    render() {
      if (!this.chart) return;
      const R = this.R, k = E.bucketOf(this.b, S.clock);
      const sel = this.kind === 'options' ? S.sel.key : '';
      if (sel !== R.sel && this.kind === 'options') this.setOptionLayers();
      const H = this.hrows.length, rows = H + Math.max(0, k) + 1;
      // Sliding window (see WIN_ROWS): trim while following the newest bar, grow when scrolled left.
      let w = this.w;
      if (S.mode === 'review') w = 0;
      else if (this.growing) w = Math.max(0, w - WIN_GROW);
      else if ((R.full || (this.following && !this.dragging)) && rows - w > WIN_ROWS + WIN_SLACK) w = rows - WIN_ROWS;
      if (R.full && this.keepW != null && S.mode !== 'review') { w = Math.min(this.keepW, w); }
      w = Math.min(w, Math.max(0, rows - WIN_ROWS));            // jumped back: keep WIN_ROWS ending at k
      if (this.wantW != null) { if (S.mode !== 'review') w = Math.min(w, this.wantW); this.wantW = null; }   // panTo
      this.keepW = null; this.growing = false;
      const shift = w - this.w;                                 // logical indexes move left by this
      const rebuild = R.full || shift !== 0 || R.mode !== S.mode || R.sel !== sel || (S.mode === 'blind' && k < R.k);
      if (rebuild || R.clock !== S.clock) {
        const T = this.times;
        const item = (j, x) => withTime(T[j], x);
        const ts = this.chart.timeScale();
        let prevRange = R.fresh ? null : (this.keepRange || ts.getVisibleLogicalRange());
        if (prevRange && shift) prevRange = { from: prevRange.from - shift, to: prevRange.to - shift };
        this.keepRange = null;
        this.w = w;
        const off = H - w;

        if (S.mode === 'review') {
          if (rebuild) for (const L of this.layers) L.series.setData(L.histData.concat(T.map((_, j) => item(j, L.full(j)))));
        } else if (rebuild) {
          for (const L of this.layers) {
            const j0 = Math.max(0, -off), out = new Array(k + 1 - j0);
            for (let j = j0; j < k; j++) out[j - j0] = item(j, L.full(j));
            out[k - j0] = item(k, L.partial(k));
            L.series.setData((w < H ? L.histData.slice(w) : []).concat(out));
            L.last = null;
          }
        } else {
          for (const L of this.layers) {
            for (let j = R.k; j < k; j++) { L.series.update(item(j, L.full(j))); L.last = null; }   // finalize passed bars
            // An unchanged forming bar is not re-sent: every update makes the library re-walk the series.
            const x = L.partial(k), key = x ? JSON.stringify(x) : '';
            if (L.last && L.last.k === k && L.last.key === key) continue;
            L.series.update(item(k, x));
            L.last = { k, key };
          }
        }
        if (rebuild && (R.fresh || R.mode !== S.mode)) {
          this.initialView(k);
          this.following = true; this.liveBtn.classList.add('hidden');
          if (R.fresh) { this.lock = null; this.autoBtn.classList.add('hidden'); }
        }
        else if (S.mode === 'blind') {
          if (rebuild && prevRange) ts.setVisibleLogicalRange(prevRange);   // setData shifts the view
          this.follow(prevRange, rebuild ? off + k : off + R.k, off + k);
          if (rebuild && !shift && prevRange && (off + k < prevRange.from || off + k > prevRange.to)) {
            const w = prevRange.to - prevRange.from;
            ts.setVisibleLogicalRange({ from: off + k - 0.8 * w, to: off + k + 0.2 * w });
            this.following = true;
          }
          if (rebuild) this.liveBtn.classList.toggle('hidden', this.following);
        }
        R.clock = S.clock; R.k = k; R.mode = S.mode; R.sel = sel; R.full = false; R.fresh = false;
        if (!this.hover) this.drawLegend(null);
        if (this.pendingPan) { const [a, b] = this.pendingPan; this.pendingPan = null; this.panTo(a, b); }
      }
      this.updateMarkers(k);
    }
  }

  const withTime = (time, x) => (x ? { time, ...x } : { time });

  // Chart times are fake-UTC seconds that read as ET wall clock. In random-blind practice the
  // date is hidden everywhere: the session is "D", prior sessions "D-1", "D-2", ….
  const pad2 = (x) => String(x).padStart(2, '0');
  function dayLabel(iso) {
    if (!S.blindDate) return iso;
    if (iso === S.meta?.session_date) return 'D';
    const i = S.hist.days.findIndex((d) => d.date === iso);
    return i < 0 ? 'D-?' : `D-${S.hist.days.length - i}`;
  }
  function fmtChartTime(t, secs) {
    const d = new Date(t * 1000);
    const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}${secs ? ':' + pad2(d.getUTCSeconds()) : ''}`;
    return `${dayLabel(d.toISOString().slice(0, 10))} ${hm}`;
  }
  function tickMark(t, type) {
    if (!S.blindDate || type > 2) return null;            // default labels unless the date is hidden
    return dayLabel(new Date(t * 1000).toISOString().slice(0, 10));
  }

  // ------------------------------------------------------------------ layout: splitters
  function applySplit() {
    const [a, b] = S.panes;
    if (!a || !b) return;
    const both = a.kind !== 'none' && b.kind !== 'none';
    $('hsplit').classList.toggle('hidden', !both);
    let r = S.layout.split;
    if (r == null) r = b.kind === 'options' ? 0.62 : a.kind === 'options' ? 0.38 : 0.5;
    a.box.style.flex = `${r} 1 0`;
    b.box.style.flex = `${1 - r} 1 0`;
  }
  function applyColumns() {
    const main = $('main');
    main.style.setProperty('--hud-w', `${S.layout.hudW}px`);
    main.classList.toggle('no-journal', !S.layout.journal);
    const col = S.layout.collapsed || {};
    for (const el of document.querySelectorAll('[data-sect]')) el.classList.toggle('collapsed', !!col[el.dataset.sect]);
  }
  // Side-panel sections collapse on a click of their header (kept in prefs with the layout).
  for (const el of document.querySelectorAll('[data-sect]')) {
    el.querySelector(':scope > .shead').addEventListener('click', () => {
      const k = el.dataset.sect;
      S.layout.collapsed = { ...(S.layout.collapsed || {}), [k]: !el.classList.contains('collapsed') };
      applyColumns(); savePrefs();
    });
  }
  function dragger(el, onMove) {
    el.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      el.classList.add('dragging');
      const move = (e) => onMove(e);
      const up = () => {
        el.classList.remove('dragging');
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
        savePrefs();
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
  }
  dragger($('hsplit'), (e) => {
    const r = $('charts').getBoundingClientRect();
    S.layout.split = Math.max(0.12, Math.min(0.88, (e.clientY - r.top) / r.height));
    applySplit();
  });
  dragger($('vsplitHud'), (e) => {
    const r = $('main').getBoundingClientRect();
    S.layout.hudW = Math.round(Math.max(260, Math.min(720, r.right - e.clientX - 2)));
    applyColumns();
  });

  // ------------------------------------------------------------------ data prep
  function prepare() {
    const m = S.meta, c = S.data.chart;
    S.byKey.clear();
    for (const [osi, ct] of Object.entries(S.data.contracts)) S.byKey.set(`${ct.type}|${ct.strike}`, osi);
    S.rowSize = m.vp_row_size || 0.05;
    const vp = E.profileSeries(c, S.rowSize);
    S.ind = { ...E.vwapSeries(c), poc: vp.poc, vah: vp.vah, val: vp.val };
    S.tapeCum = E.tapeCum(c);
    S.profileIdx = null;
    const rootUnd = m.root === 'SPXW' ? 'SPX' : m.root;
    for (const p of S.panes) {
      p.srcSel.options[0].text = `${c.symbol} trades`;
      p.srcSel.options[1].text = `${rootUnd} underlying`;
    }
    $('chartSym').textContent = c.symbol;
    $('rootSym').textContent = rootUnd;
    $('rootRow').classList.toggle('hidden', rootUnd === c.symbol);
  }

  // Selected contracts follow the as-of underlying (live tool semantics), C and P.
  function updateSelection() {
    const u = S.data.underlying;
    const px = E.valueAsOf(u.t, u.p, S.clock);
    if (px == null) { S.sel = { key: '|', px: null, C: null, P: null }; return; }
    const strikes = S.meta.strikes;
    const kc = E.pickStrike(strikes, px, 'C', S.offset), kp = E.pickStrike(strikes, px, 'P', S.offset);
    const C = S.byKey.get(`C|${kc}`) || null, P = S.byKey.get(`P|${kp}`) || null;
    S.sel = { key: `${C}|${P}`, px, C, P, kc, kp };
  }

  function updateProfile() {
    if (!S.panes.some((p) => p.profile)) return;
    const c = S.data.chart;
    const idx = S.mode === 'review' ? c.t.length - 1 : E.asOfIndex(c.t, S.clock);
    if (idx === S.profileIdx) return;
    S.profileIdx = idx;
    S.profile = E.profileAsOf(c, S.rowSize, idx);
    for (const p of S.panes) p.setProfile(S.profile);
  }

  // ------------------------------------------------------------------ trading
  function quoteNow(osi) {
    const c = S.data.contracts[osi];
    const i = E.asOfIndex(c.t, S.clock);
    return i < 0 ? null : { t: c.t[i], bid: c.bid[i], ask: c.ask[i], mid: c.mid[i] };
  }
  async function exactQuote(osi, t) {
    const m = S.meta;
    return getJson(`/api/quote?date=${m.session_date}&root=${m.root}&dte=${m.dte}&osi=${encodeURIComponent(osi)}&t=${t}`);
  }

  // Position = one contract + its fills. The same side again ADDS to it (same contract, at the
  // mid, whatever the current offset); entry = quantity-weighted average of the fills.
  function syncPos(pos) {
    const a = E.avgEntry(pos.fills);
    pos.qty = a.qty; pos.entry_mid = a.mid; pos.entry_t = a.t;
    pos.exact = pos.fills.every((f) => f.exact);
  }
  async function openPos(type) {
    if (!S.data) return;
    const why = E.canOpen(S.pos, S.mode, type);
    if (why) return toast(why, 'err');
    const adding = !!S.pos;
    const osi = adding ? S.pos.osi : S.sel[type];
    if (!osi) return toast(`No ${type === 'C' ? 'call' : 'put'} contract at this offset`, 'err');
    const q = quoteNow(osi);
    if (!q) return toast('No quote yet for that contract', 'err');
    const c = S.data.contracts[osi], t = Math.floor(S.clock);   // clock is fractional mid-playback
    const fill = { t, mid: q.mid, qty: S.qty, exact: false };
    if (adding) S.pos.fills.push(fill);
    else S.pos = { osi, type, strike: c.strike, offset: S.offset, fills: [fill], note: '' };
    if (E.seenBefore(W.spans, W.pass, t)) S.pos.afterRewind = true;
    if (W.reviewed) S.pos.afterReview = true;
    const pos = S.pos;
    syncPos(pos);
    S.tradesVer++;
    toast(adding
      ? `ADD ${type} ${c.strike} ×${S.qty} @ ${q.mid.toFixed(2)} (mid) → ×${pos.qty} avg ${pos.entry_mid.toFixed(2)}`
      : `BUY ${type} ${c.strike} ×${S.qty} @ ${q.mid.toFixed(2)} (mid) · ${E.fmtClock(t)}`, 'ok');
    try {
      const x = await exactQuote(osi, t);
      if (S.pos === pos && pos.fills.includes(fill)) {
        if (Math.abs(x.mid - fill.mid) > 1e-9) toast(`Fill re-priced to exact tick: ${x.mid.toFixed(2)}`);
        fill.mid = x.mid; fill.exact = true;
        syncPos(pos);
        S.tradesVer++;
      }
    } catch (e) { toast(`Exact re-price failed (${e.message}); keeping ${q.mid.toFixed(2)}`, 'err'); }
  }

  async function closePos() {
    if (!S.data) return;
    const why = E.canClose(S.pos);
    if (why) return toast(why, 'err');
    const pos = S.pos, t = Math.floor(S.clock);
    let q = quoteNow(pos.osi);
    try { q = await exactQuote(pos.osi, t); } catch (e) { toast(`Exact re-price failed (${e.message}); using 1s data`, 'err'); }
    if (!q) return toast('No bid available to close against', 'err');
    const c = S.data.contracts[pos.osi];
    const exc = E.excursion(c.t, c.bid, pos.fills, t);
    const m = S.meta;
    const rec = {
      session_date: m.session_date, root: m.root, dte: m.dte, expiry: m.expiry, osi: pos.osi, strike: pos.strike,
      type: pos.type, qty: pos.qty, entry_t: pos.entry_t, entry_mid: pos.entry_mid, exit_t: t, exit_bid: q.bid,
      offset: pos.offset, mfe: Math.round(exc.mfe * 100) / 100, mae: Math.round(exc.mae * 100) / 100,
      fills: pos.fills.map((f) => ({ t: f.t, mid: f.mid, qty: f.qty })),
      note: pos.note || '', blind_date: !!S.blindDate,
      after_rewind: pos.fills.some((f) => E.seenBefore(W.spans, W.pass, f.t)) || !!pos.afterRewind,
      after_review: W.reviewed || !!pos.afterReview,
    };
    S.pos = null;
    try {
      const saved = await postJson('/api/journal', rec);
      S.journal.push(saved);
      toast(`SELL ${rec.type} ${rec.strike} ×${rec.qty} @ ${q.bid.toFixed(2)} (bid) · ${money(saved.pnl)}`, saved.pnl >= 0 ? 'ok' : 'err');
    } catch (e) {
      const pnl = E.optionPnl(rec.entry_mid, rec.exit_bid, rec.qty);
      S.journal.push({ ...rec, id: `unsaved-${Date.now()}`, pnl, unsaved: true });
      toast(`Closed (${money(pnl)}) but NOT saved to the journal: ${e.message}`, 'err');
    }
    S.tradesVer++;
    renderJournal();
  }

  // SKIP: "I saw a setup here and passed". Pauses, asks for an optional reason (Enter saves,
  // Esc cancels the skip), and logs it at the press-time clock.
  function skipSetup() {
    if (!S.data || !W.ready) return;
    if (S.mode !== 'blind') return toast('Skips are logged in BLIND only', 'err');
    const t = Math.floor(S.clock), wasPlaying = S.playing;
    S.playing = false;
    const spot = E.valueAsOf(S.data.underlying.t, S.data.underlying.p, t);
    const chartPx = S.data.chart ? E.valueAsOf(S.data.chart.t, S.data.chart.c, t) : null;
    openNote(`Skip at ${E.fmtClock(t)} — why pass? (optional)`, '', async (note) => {
      const ev = { kind: 'skip', ...watchBase(), t, note, pass: W.pass, offset: S.offset,
        underlying: spot, chart: chartPx, wall: new Date().toISOString() };
      try {
        const [saved] = (await postJson('/api/watch', { events: [ev] })).events;
        W.skips.push(saved);
        toast(`SKIP logged at ${E.fmtClock(t)}`, 'ok');
      } catch (e) { toast(`Skip NOT saved: ${e.message}`, 'err'); }
      S.tradesVer++; renderJournal(true);
    }, () => { if (wasPlaying) S.playing = true; });
  }

  let noteCb = null;
  function openNote(title, text, onSave, onClose) {
    $('noteTitle').textContent = title;
    $('noteText').value = text || '';
    noteCb = { onSave, onClose };
    $('noteDlg').classList.remove('hidden');
    $('noteText').focus();
  }
  function closeNote(save) {
    if (!noteCb) return;
    const cb = noteCb, text = $('noteText').value.trim();
    noteCb = null;
    $('noteDlg').classList.add('hidden');
    $('noteText').blur();
    if (save) cb.onSave(text);
    if (cb.onClose) cb.onClose();
  }
  $('noteText').addEventListener('keydown', (ev) => {
    ev.stopPropagation();                                  // no hotkeys while typing a note
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); closeNote(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); closeNote(false); }
  });
  $('noteSave').onclick = () => closeNote(true);
  $('noteCancel').onclick = () => closeNote(false);
  $('noteDlg').onclick = (ev) => { if (ev.target === $('noteDlg')) closeNote(false); };

  async function editNote(kind, id) {
    if (kind === 'open') {
      if (!S.pos) return;
      return openNote(`Note — open ${S.pos.type} ${S.pos.strike}`, S.pos.note, (note) => { if (S.pos) S.pos.note = note; S.tradesVer++; });
    }
    if (kind === 'skip') {
      const sk = W.skips.find((x) => x.id === id);
      if (!sk) return;
      return openNote(`Note — skip at ${E.fmtClock(sk.t)}`, sk.note, async (note) => {
        try { Object.assign(sk, await getJson(`/api/watch?id=${encodeURIComponent(id)}`, patchOpts(note))); }
        catch (e) { toast(`Note not saved: ${e.message}`, 'err'); }
        S.tradesVer++; renderJournal(true);
      });
    }
    const tr = S.journal.find((x) => x.id === id);
    if (!tr) return;
    openNote(`Note — ${tr.type} ${tr.strike} · ${E.fmtClock(tr.entry_t)} → ${E.fmtClock(tr.exit_t)} · ${money(tr.pnl)}`, tr.note, async (note) => {
      if (tr.unsaved) tr.note = note;
      else {
        try { Object.assign(tr, await getJson(`/api/journal?id=${encodeURIComponent(id)}`, patchOpts(note))); }
        catch (e) { toast(`Note not saved: ${e.message}`, 'err'); }
      }
      S.tradesVer++; renderJournal(true);
    });
  }
  const patchOpts = (note) => ({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) });

  function setQty(n) { S.qty = Math.max(1, Math.min(100, n)); savePrefs(); }
  function setOffset(o) {
    const w = S.meta ? S.meta.strike_window : 15;
    S.offset = Math.max(-w, Math.min(w, o)); savePrefs();
  }

  // ------------------------------------------------------------------ journal panel
  const label = (t) => `${t.type || ''}${t.strike != null ? t.strike : t.symbol || ''}`;
  function tradeSets() {
    const sets = [];
    if (S.show.practice) sets.push({ kind: 'practice', trades: S.journal.map((t) => ({ ...t, entry_price: t.entry_mid, exit_price: t.exit_bid, label: label(t) })) });
    if (S.show.broker && !S.blindDate) sets.push({ kind: 'broker', trades: S.broker.map((t) => ({ ...t, label: label(t) })) });
    if (S.show.upload && !S.blindDate) sets.push({ kind: 'upload', trades: S.uploads.map((t) => ({ ...t, label: label(t) })) });
    return sets;
  }
  const visibleInBlind = (t) => S.mode === 'review' || t.entry_t == null || t.entry_t <= S.clock;

  let lastJournalKey = '';
  function renderJournal(force) {
    const tab = S.jtab;
    const list = tab === 'practice' ? S.journal : S.blindDate ? [] : tab === 'broker' ? S.broker : S.uploads;
    const shown = tab === 'practice' ? list : list.filter(visibleInBlind);
    const key = `${tab}|${S.tradesVer}|${shown.length}|${W.skips.filter((x) => x.t <= S.clock).length}|${S.mode}|${S.show[tab]}|${S.pos ? 1 : 0}|${S.blindDate}|${S.jsort}`;
    if (!force && key === lastJournalKey) return;
    lastJournalKey = key;
    for (const b of document.querySelectorAll('.jtabs button')) b.classList.toggle('active', b.dataset.tab === tab);
    $('jShow').checked = S.show[tab];
    $('jExport').classList.toggle('hidden', tab !== 'practice');
    $('jExportAll').classList.toggle('hidden', tab !== 'practice');
    $('jReset').classList.toggle('hidden', tab !== 'practice');
    $('jClear').classList.toggle('hidden', tab !== 'upload' || !S.uploadFiles.length);

    const closed = shown.filter((t) => t.pnl != null);
    const net = closed.reduce((a, t) => a + t.pnl, 0), wins = closed.filter((t) => t.pnl > 0).length;
    $('jSum').innerHTML = `<span>${closed.length} trade${closed.length === 1 ? '' : 's'}</span>` +
      `<span>win ${closed.length ? Math.round((100 * wins) / closed.length) : 0}%</span>` +
      `<span class="${sgnCls(net)}"><b>${money(net)}</b></span>` +
      ((n) => (tab === 'practice' && n ? `<span class="muted">${n} skip${n === 1 ? '' : 's'}</span>` : ''))(
        W.skips.filter((x) => S.mode === 'review' || x.t <= S.clock).length);

    const rows = [];
    const practice = tab === 'practice';
    const noteLine = (n) => (n ? `<span class="note">${esc(n)}</span>` : '');
    const go = (t) => (t != null ? `<button class="go" data-go="${t}" title="Jump the clock here (going back is logged as a rewind)">⏱</button>` : '');
    const nb = (kind, id) => `<button class="nb" data-nk="${kind}" data-nid="${id || ''}" title="Add / edit the note">✎</button>`;
    const showTitle = 'Click to show it on the charts (same zoom; the clock doesn’t move)';
    let openRow = '';
    if (practice && S.pos) {
      openRow = (`<div class="jrow" data-t="${S.pos.entry_t}" title="${showTitle}"><span class="c">OPEN ${S.pos.type} ${S.pos.strike} ×${S.pos.qty}</span>` +
        `<span class="p muted">live ${nb('open')}</span><span class="t">${E.fmtClock(S.pos.entry_t)} →</span><span class="px">${S.pos.entry_mid.toFixed(2)}</span>${noteLine(S.pos.note)}</div>`);
    }
    const skips = practice ? W.skips.filter((x) => S.mode === 'review' || x.t <= S.clock) : [];
    const items = shown.map((t) => ({ t: t.entry_t ?? 0, tr: t })).concat(skips.map((x) => ({ t: x.t, sk: x })));
    const dir = S.jsort === 'asc' ? 1 : -1;
    if (openRow && dir < 0) rows.push(openRow);                    // the open position is the newest
    for (const { tr: t, sk } of items.sort((a, b) => dir * (a.t - b.t))) {
      if (sk) {
        rows.push(`<div class="jrow skip" data-t="${sk.t}" title="${showTitle}">` +
          `<span class="c">SKIP</span><span class="p muted">${nb('skip', sk.id)}${go(sk.t)}</span><span class="t">${E.fmtClock(sk.t)}</span><span class="px"></span>${noteLine(sk.note)}</div>`);
        continue;
      }
      const ep = t.entry_price ?? t.entry_mid, xp = t.exit_price ?? t.exit_bid;
      const name = practice ? `${t.type} ${t.strike} ×${t.qty}` : `${t.root || t.symbol} ${t.type || ''} ${t.strike ?? ''} ×${t.qty}`;
      const del = practice ? `<button class="del" data-del="${t.id}" title="Delete from journal">✕</button>` : '';
      const flags = (t.after_rewind ? ' <span class="flag" title="Entered on time already watched (after a rewind)">↺</span>' : '')
        + (t.after_review ? ' <span class="flag" title="REVIEW was opened on this session before this trade">R</span>' : '');
      const at = t.entry_t ?? t.exit_t;                              // carried in from a prior day: show the exit
      const memo = practice ? t.note : [t.tag, t.note].filter(Boolean).join(' — ');   // uploads keep the file's tag / note
      rows.push(`<div class="jrow" data-t="${at ?? ''}" data-x="${t.entry_t != null ? t.exit_t ?? '' : ''}" title="${showTitle}">` +
        `<span class="c">${name}${flags}${t.unsaved ? ' <span class="neg">(unsaved)</span>' : ''}</span>` +
        `<span class="p ${sgnCls(t.pnl)}">${money(t.pnl)} ${practice ? nb('trade', t.id) : ''}${go(at)}${del}</span>` +
        `<span class="t">${t.entry_t != null ? E.fmtClock(t.entry_t) : t.entry_ts ? t.entry_ts.slice(0, 10) : '—'} → ${t.exit_t != null ? E.fmtClock(t.exit_t) : t.exit_ts ? t.exit_ts.slice(0, 10) : 'open'}</span>` +
        `<span class="px">${f2(ep)} → ${f2(xp)}</span>${noteLine(memo)}</div>`);
    }
    if (openRow && dir > 0) rows.push(openRow);
    $('jSort').textContent = dir > 0 ? '↑ oldest' : '↓ newest';
    const jl = $('jList'), atEnd = jl.scrollTop + jl.clientHeight >= jl.scrollHeight - 4;
    jl.innerHTML = rows.join('') || '<div class="jfoot muted">No trades.</div>';
    if (dir > 0 && atEnd) jl.scrollTop = jl.scrollHeight;          // oldest first: keep the newest in view
    const hidden = list.length - shown.length;
    $('jFoot').textContent = (hidden > 0 ? `${hidden} later trade${hidden === 1 ? '' : 's'} hidden until the clock reaches them (BLIND) — press v for REVIEW to see all. ` : '')
      + (tab === 'broker' ? (S.blindDate ? 'Hidden during random-blind practice — Reveal to show.' : (S.brokerNote || 'From order_history.json (read-only).')) : '')
      + (tab === 'upload' ? (S.blindDate ? 'Hidden during random-blind practice — Reveal to show.'
        : S.uploadFiles.length ? `Files (kept across days): ${S.uploadFiles.map((f) => f.name).join(', ')}.`
          : 'Drop or upload an order_history-style JSON or a practice export.') : '');
  }

  $('jList').onclick = async (ev) => {
    const del = ev.target.closest('[data-del]');
    if (del) {
      ev.stopPropagation();
      const id = del.dataset.del;
      if (!confirm('Delete this practice trade from the journal?')) return;
      try {
        if (!id.startsWith('unsaved-')) await getJson(`/api/journal?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        S.journal = S.journal.filter((t) => t.id !== id); S.tradesVer++; renderJournal(true);
      } catch (e) { toast(`Delete failed: ${e.message}`, 'err'); }
      return;
    }
    const go = ev.target.closest('[data-go]');
    if (go) {
      ev.stopPropagation();
      const t = +go.dataset.go;
      seek(t);
      for (const p of S.panes) p.showPrice(p.kind === 'none' ? null : p.priceAt(t));   // same zoom, entry in view
      return;
    }
    const nbtn = ev.target.closest('[data-nk]');
    if (nbtn) { ev.stopPropagation(); return editNote(nbtn.dataset.nk, nbtn.dataset.nid); }
    const row = ev.target.closest('.jrow');
    if (!row || !row.dataset.t || !S.data) return;                    // other-day overlay rows: nothing to show
    const t0 = +row.dataset.t, t1 = row.dataset.x ? +row.dataset.x : null;
    if (S.mode === 'blind' && t0 > S.clock) return toast('That’s after the clock — not on the chart yet', 'err');
    for (const p of S.panes) {
      if (p.kind === 'none') continue;
      p.panTo(t0, t1 != null && (S.mode === 'review' || t1 <= S.clock) ? t1 : null);
      p.showPrice(p.priceAt(t0));
    }
  };
  $('jSort').onclick = (ev) => { ev.currentTarget.blur(); S.jsort = S.jsort === 'asc' ? 'desc' : 'asc'; savePrefs(); renderJournal(true); };
  $('jExportAll').onclick = async (ev) => {
    ev.target.blur();
    try {
      flushWatch(false);
      const all = await getJson('/api/export');
      const blob = new Blob([JSON.stringify(all, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `practice_all_${all.journal_file.replace(/\.jsonl$/, '')}_${all.exported_at.slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast(`Exported ${all.trades.length} trades + ${all.watch.length} watch-log events`, 'ok');
    } catch (e) { toast(`Export failed: ${e.message}`, 'err'); }
  };
  for (const b of document.querySelectorAll('.jtabs button')) {
    b.onclick = () => { S.jtab = b.dataset.tab; savePrefs(); renderJournal(true); };
  }
  $('jShow').onchange = (ev) => { S.show[S.jtab] = ev.target.checked; S.tradesVer++; savePrefs(); ev.target.blur(); renderJournal(true); };
  $('jReset').onclick = async (ev) => {
    ev.target.blur();
    if (!S.meta) return;
    const n = S.journal.length + (S.pos ? 1 : 0);
    if (!n) return toast('No practice trades to reset', 'err');
    const what = `${S.journal.length} practice trade${S.journal.length === 1 ? '' : 's'}${S.pos ? ' + the open position' : ''}`;
    if (!confirm(`Reset ${what} for this session? Other days and your real trades are not affected. This cannot be undone.`)) return;
    try {
      const r = await getJson(`/api/journal?date=${S.meta.session_date}&root=${S.meta.root}`, { method: 'DELETE' });
      S.journal = []; S.pos = null; S.tradesVer++; renderJournal(true);
      toast(`Reset: ${r.deleted} trade${r.deleted === 1 ? '' : 's'} removed`, 'ok');
    } catch (e) { toast(`Reset failed: ${e.message}`, 'err'); }
  };
  $('jExport').onclick = () => {
    const blob = new Blob([JSON.stringify(S.journal, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `practice_${S.meta ? S.meta.root + '_' + S.meta.session_date : 'trades'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('jUpload').onclick = () => $('jFile').click();
  $('jFile').onchange = (ev) => { if (ev.target.files[0]) uploadFile(ev.target.files[0]); ev.target.value = ''; };

  const parseUpload = (f, date) =>
    postJson(`/api/parse-trades?date=${date}&name=${encodeURIComponent(f.name)}`, f.obj).then((r) => r.trades);
  async function uploadFile(file) {
    if (!S.meta) return toast('Load a session first', 'err');
    try {
      const f = { name: file.name, obj: JSON.parse(await file.text()) };
      const trades = await parseUpload(f, S.meta.session_date);
      S.uploadFiles = S.uploadFiles.filter((g) => g.name !== f.name).concat(f);
      const kept = saveUploadFiles();
      S.uploads = S.uploads.filter((t) => t.source !== `upload:${f.name}`).concat(trades);
      S.tradesVer++; S.jtab = 'upload'; renderJournal(true);
      const days = Array.isArray(f.obj) ? new Set(f.obj.map((r) => r && r.session_date).filter(Boolean)).size : 0;
      toast(`${f.name}: ${trades.length} round trip${trades.length === 1 ? '' : 's'} on ${S.blindDate ? 'this session' : S.meta.session_date}`
        + (days > 1 ? ` (file covers ${days} sessions; each shows when loaded)` : '')
        + (kept ? '' : ' — too big to remember after a reload')
        + (S.mode === 'blind' && trades.some((t) => !visibleInBlind(t)) ? ' · BLIND hides later ones: v = REVIEW' : ''), 'ok');
    } catch (e) { toast(`Upload failed: ${e.message}`, 'err'); }
  }
  /** Re-filter every kept upload file to the session just loaded. */
  async function refreshUploads() {
    const date = S.meta.session_date, ver = ++S.uploadsReq;
    const parts = await Promise.all(S.uploadFiles.map((f) => parseUpload(f, date).catch((e) => {
      toast(`${f.name}: ${e.message}`, 'err'); return [];
    })));
    if (ver !== S.uploadsReq || !S.meta || S.meta.session_date !== date) return;   // a newer load won
    S.uploads = parts.flat(); S.tradesVer++; renderJournal(true);
  }
  $('jClear').onclick = (ev) => {
    ev.target.blur();
    S.uploadFiles = []; S.uploads = []; saveUploadFiles();
    S.tradesVer++; renderJournal(true);
  };
  let dragDepth = 0;
  window.addEventListener('dragenter', (ev) => { if (ev.dataTransfer.types.includes('Files')) { dragDepth++; $('drop').classList.remove('hidden'); } });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').classList.add('hidden'); } });
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => {
    ev.preventDefault(); dragDepth = 0; $('drop').classList.add('hidden');
    const f = ev.dataTransfer.files[0];
    if (f) uploadFile(f);
  });

  // ------------------------------------------------------------------ HUD
  function quoteHud(prefix, osi, strike) {
    if (!osi) {
      $(prefix + 'Strike').textContent = strike != null ? `${strike} (no data)` : '—';
      for (const f of ['Bid', 'Mid', 'Ask']) $(prefix + f).textContent = '—';
      $(prefix + 'Age').textContent = '';
      return;
    }
    const q = quoteNow(osi), c = S.data.contracts[osi];
    $(prefix + 'Strike').textContent = `${c.strike}`;
    $(prefix + 'Bid').textContent = q ? f2(q.bid) : '—';
    $(prefix + 'Mid').textContent = q ? f2(q.mid) : '—';
    $(prefix + 'Ask').textContent = q ? f2(q.ask) : '—';
    $(prefix + 'Age').textContent = q ? `quote age ${((S.clock - q.t) / 1000).toFixed(1)}s` : 'no quote yet';
  }

  function hud() {
    const c = S.data.chart, ind = S.ind;
    $('clock').textContent = E.fmtClock(S.clock);
    $('playState').textContent = S.playing ? 'PLAYING'
      : S.clock >= S.meta.close_ms ? 'CLOSED' : S.clock === S.meta.open_ms ? 'READY · space to play' : 'PAUSED';
    $('speed').textContent = $('speed2').textContent = speedLabel();
    const i = E.asOfIndex(c.t, S.clock);
    if (i < 0) {
      for (const id of ['chartPx', 'vwapPx', 'vaInfo']) $(id).textContent = '—';
    } else {
      const last = E.priceAsOf(c, S.clock), v = ind.vwap[i], sd = ind.sd[i];
      const z = sd > 0 ? (last - v) / sd : 0;
      $('chartPx').textContent = f2(last);
      $('vwapPx').textContent = `${f2(v)}  (${z >= 0 ? '+' : ''}${z.toFixed(2)}σ)`;
      $('vaInfo').textContent = `${f2(ind.val[i])} / ${f2(ind.poc[i])} / ${f2(ind.vah[i])}`;
    }
    const tape = E.tapeStats(c, S.tapeCum, S.clock, 10000, S.meta.open_ms);
    const ratio = tape.avg > 0 ? tape.rate / tape.avg : 0;
    $('tapePx').textContent = i < 0 ? '—' : `${tape.rate.toFixed(0)}/s · ${ratio.toFixed(1)}× avg`;
    $('tapePx').className = ratio >= 2 ? 'hot' : '';
    $('rootPx').textContent = f2(S.sel.px);
    $('offset').textContent = S.offset > 0 ? `+${S.offset}` : `${S.offset}`;
    $('offsetLbl').textContent = S.offset === 0 ? 'ATM' : S.offset > 0 ? 'OTM' : 'ITM';
    $('qty').textContent = S.qty;
    quoteHud('c', S.sel.C, S.sel.kc);
    quoteHud('p', S.sel.P, S.sel.kp);
    const pos = S.pos;
    $('posBox').classList.toggle('hidden', !pos);
    const canTrade = S.mode === 'blind';
    $('buyCall').disabled = !canTrade || (!!pos && pos.type !== 'C');
    $('buyPut').disabled = !canTrade || (!!pos && pos.type !== 'P');
    const btn = (id, type) => {
      const add = pos && pos.type === type;
      const html = `${add ? 'Add' : 'Buy'} ${type} <kbd>${type.toLowerCase()}</kbd>`;
      if ($(id).innerHTML !== html) $(id).innerHTML = html;
    };
    btn('buyCall', 'C'); btn('buyPut', 'P');
    $('closePos').disabled = !pos;
    if (pos) {
      const q = quoteNow(pos.osi), c2 = S.data.contracts[pos.osi];
      const pnl = q ? E.optionPnl(pos.entry_mid, q.bid, pos.qty) : null;
      const exc = E.excursion(c2.t, c2.bid, pos.fills, S.clock);
      $('posTitle').textContent = `LONG ${pos.type} ${pos.strike} ×${pos.qty}`;
      $('posHold').textContent = `${E.fmtClock(pos.entry_t)} · ${Math.round((S.clock - pos.entry_t) / 1000)}s`;
      $('posEntry').textContent = `${pos.fills.length > 1 ? `avg of ${pos.fills.length} · ` : ''}${pos.entry_mid.toFixed(2)}${pos.exact ? '' : ' …'}`;
      $('posBid').textContent = q ? f2(q.bid) : '—';
      $('posPnl').textContent = money(pnl);
      $('posPnl').className = sgnCls(pnl);
      $('posExc').textContent = `${money(exc.mfe)} / ${money(exc.mae)}`;
    }
    $('play').innerHTML = S.playing ? '&#x23F8;' : '&#x25B6;';
    if (document.activeElement !== $('timeline')) $('timeline').value = S.clock;
  }

  function showMeta() {
    const m = S.meta;
    $('meta').textContent =
      (S.blindDate ? `${m.root} · ${m.dte}DTE · date hidden (Reveal to show)\n`
        : `${m.root} ${m.session_date} · ${m.dte}DTE → exp ${m.expiry}\n`) +
      `ATM at open ${m.atm_strike_at_open} · ${m.strikes.length} strikes (±${m.strike_window})\n` +
      `chart: ${m.chart_symbol} trades · strikes from: ${m.underlying_source.split(' (')[0]}`;
  }

  // ------------------------------------------------------------------ clock
  let lastFrame = performance.now();
  let lastHud = null;
  function frame(now) {
    const dt = now - lastFrame;
    lastFrame = now;
    if (S.data) {
      if (S.playing) {
        S.clock = E.advanceClock(S.clock, dt, speed(), S.meta.open_ms, S.meta.close_ms);
        if (S.clock >= S.meta.close_ms) S.playing = false;
      }
      watchTick();
      updateSelection();
      updateProfile();
      for (const p of S.panes) p.render();
      const hudKey = `${S.clock}|${S.playing}|${S.speedIdx}|${S.offset}|${S.qty}|${S.sel.key}|${S.tradesVer}|${S.mode}`;
      if (hudKey !== lastHud) { hud(); lastHud = hudKey; }
      renderJournal();
    }
    requestAnimationFrame(frame);
  }

  const visibleIvs = () => S.panes.filter((p) => p.kind !== 'none').map((p) => E.INTERVALS[p.iv]);
  function seek(ms, continuous) {
    if (!S.data || ms == null) return;
    if (!continuous) W.jumped = true;               // forward seeks skip unwatched time
    let t = Math.min(S.meta.close_ms, Math.max(S.meta.open_ms, ms));
    const lastFill = S.pos ? S.pos.fills[S.pos.fills.length - 1].t : null;
    if (S.pos && t < lastFill) {                     // can't rewind past an open position's last fill
      t = lastFill;
      toast('In a position — can’t rewind before its last fill (close it first)', 'err');
    }
    S.clock = t;
    for (const p of S.panes) p.R.full = true;      // rebuild prefix (also handles backwards seeks)
  }
  function step(dir, coarse) {
    if (!S.data) return;
    S.playing = false;
    const iv = coarse ? Math.max(...visibleIvs()) : Math.min(...visibleIvs());
    seek(E.stepBoundary(S.clock, iv, dir, S.meta.open_ms, S.meta.close_ms), dir > 0);   // stepping on = watching
  }
  // Fixed forward/back jumps (Ctrl+arrows). Forward = skipped time (not watched), so a new pass.
  function jumpBy(ms) {
    if (!S.data) return;
    if (ms > 0) W.jumpRule = { rule: 'fixed', by_s: ms / 1000 };
    seek(S.clock + ms, false);
  }
  // n = skip the dead zone: jump to whichever comes first —
  //   1) the next 1s close beyond ±k σ of session VWAP (minus the lead, to watch the approach);
  //   2) 2 s after an outsized 1s candle (range >= big × the largest 1s range of the prior 5 min).
  // Causal scans (Engine.nextZoneExit / nextBigCandle) — the clock a playback paused on the event
  // would reach; logged as a rule jump so the skipped time reads as "nothing by my rules", not
  // inattention. Refused in a position (would skip managing it).
  const ZONE_REARM_MS = 30000;     // back inside this long before the next breakout counts
  function zoneSkip() {
    if (!S.data || !S.ind) return;
    if (S.pos) return toast('In a position — zone skip would skip managing it (close it first)', 'err');
    const c = S.data.chart, { k, lead, big } = S.zone;
    S.playing = false;
    const tb = E.nextZoneExit(c.t, c.c, S.ind.vwap, S.ind.sd, S.clock, k, ZONE_REARM_MS);
    let tc = E.nextBigCandle(c.t, c.h, c.l, S.clock, big, S.meta.open_ms);
    if (tc != null && tc > S.meta.close_ms) tc = null;
    const rule = { rule: 'zone', k, lead_s: lead, big };
    if (tb == null && tc == null) {
      W.jumpRule = { ...rule, stop: 'close' };
      seek(S.meta.close_ms, false);
      return toast(`Nothing beyond ±${k}σ${big > 0 ? ' or outsized' : ''} to the close`, 'ok');
    }
    let to = tb == null ? Infinity : tb - lead * 1000;
    if (tb != null && to <= S.clock + 1000) to = tb;   // already within the lead: go to the move itself
    if (tc != null && tc <= to) {                       // the candle comes first (no lead: it'd leak)
      W.jumpRule = { ...rule, stop: 'candle' };
      seek(tc, false);
      return toast(`⏭ ${E.fmtClock(tc)} — outsized 1s candle (2 s ago)`, 'ok');
    }
    W.jumpRule = { ...rule, stop: 'sigma' };
    seek(to, false);
    toast(`⏭ ${E.fmtClock(to)} — ${to < tb ? `±${k}σ in ${lead}s` : `beyond ±${k}σ`}`, 'ok');
  }
  function setSpeed(i) { S.speedIdx = Math.max(0, Math.min(E.SPEEDS.length - 1, i)); savePrefs(); }
  function setMode(mode) {
    if (mode === 'review' && S.pos) return toast('Close the open position before REVIEW (it shows the future)', 'err');
    const changed = mode !== S.mode;
    S.mode = mode;
    if (changed) watchMode(mode);
    $('mode').textContent = mode === 'blind' ? 'BLIND' : 'REVIEW';
    $('mode').className = `mode ${mode}`;
    S.profileIdx = null;
  }
  function togglePlay() {
    if (!S.data) return;
    if (!S.playing && S.clock >= S.meta.close_ms) seek(S.meta.open_ms);
    S.playing = !S.playing;
  }

  function applyView(name) {
    S.view = name;
    $('view').value = name;
    if (PRESETS[name]) PRESETS[name].panes.forEach(([kind, iv], i) => S.panes[i].configure(kind, iv));
    savePrefs();
  }
  function onPaneControl(i) {
    const p = S.panes[i];
    if (p.srcSel.value === 'none' && S.panes[1 - i].kind === 'none') p.srcSel.value = p.kind;  // keep one pane
    p.configure(p.srcSel.value, p.ivSel.value);
    S.view = 'custom'; $('view').value = 'custom';
    savePrefs();
  }

  // ------------------------------------------------------------------ loading
  function overlay(msg) {
    $('overlay').classList.toggle('hidden', !msg);
    $('overlayMsg').textContent = msg || '';
  }
  async function getJson(url, opts) {
    const r = await fetch(url, opts);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }
  const postJson = (url, obj) => getJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

  async function loadSessions() {
    const root = $('root').value, dte = $('dte').value;
    const j = await getJson(`/api/sessions?root=${root}&dte=${dte}`);
    S.sessions = j.sessions;
    S.sessionSet = new Set(j.sessions);
    snapDate();
  }

  // Snap the date input to an available session (next one at/after, else the last).
  function snapDate() {
    const want = $('date').value, list = S.sessions;
    if (!list.length) { $('note').textContent = 'no sessions for this root/DTE'; return; }
    if (S.sessionSet.has(want)) { $('note').textContent = ''; setDate(want); return; }
    const next = list.find((d) => d >= want) || list[list.length - 1];
    $('note').textContent = want ? `${want} unavailable → ${next}` : '';
    setDate(next);
  }
  function shiftDay(dir) {
    const list = S.sessions, i = list.indexOf($('date').value);
    const j = i < 0 ? list.length - 1 : Math.max(0, Math.min(list.length - 1, i + dir));
    setDate(list[j]); $('note').textContent = '';
  }

  // ------------------------------------------------------------------ session calendar
  // Only days present in S.sessions are clickable — availability is data-driven, so a source
  // with weekend sessions (e.g. futures) would light up weekends automatically.
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  const cal = { month: null };            // 'YYYY-MM' being shown

  function setDate(iso) {
    $('date').value = iso || '';
    if (S.blindDate && iso) { $('dateBtn').textContent = '🎲 date hidden'; return; }
    if (!iso) { $('dateBtn').textContent = 'pick date'; return; }
    const d = new Date(`${iso}T00:00:00Z`);
    $('dateBtn').textContent = `${iso} ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]}`;
  }
  function shiftMonth(ym, n) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m - 1 + n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  function drawCal() {
    const [y, m] = cal.month.split('-').map(Number);
    const startDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const nDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const sel = $('date').value;
    const cells = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map((d) => `<div class="dow">${d}</div>`);
    for (let i = 0; i < startDow; i++) cells.push('<div></div>');
    let count = 0;
    for (let d = 1; d <= nDays; d++) {
      const iso = `${cal.month}-${String(d).padStart(2, '0')}`;
      const ok = S.sessionSet.has(iso);
      if (ok) count++;
      cells.push(ok
        ? `<button class="avail${iso === sel ? ' sel' : ''}" data-iso="${iso}">${d}</button>`
        : `<button disabled>${d}</button>`);
    }
    const first = S.sessions[0] || '', last = S.sessions[S.sessions.length - 1] || '';
    $('cal').innerHTML =
      `<div class="cal-head"><button data-nav="-12" title="Previous year">«</button><button data-nav="-1" title="Previous month">‹</button>` +
      `<b>${MONTHS[m - 1]} ${y}</b><button data-nav="1" title="Next month">›</button><button data-nav="12" title="Next year">»</button></div>` +
      `<div class="cal-grid">${cells.join('')}</div>` +
      `<div class="cal-foot"><span>${count} session${count === 1 ? '' : 's'}</span><span>${first} → ${last}</span></div>`;
  }
  function openCal() {
    if (!S.sessions.length) return;
    cal.month = ($('date').value || S.sessions[S.sessions.length - 1]).slice(0, 7);
    drawCal();
    $('cal').classList.remove('hidden');
  }
  const closeCal = () => $('cal').classList.add('hidden');
  $('dateBtn').onclick = (ev) => { ev.stopPropagation(); if ($('cal').classList.contains('hidden')) openCal(); else closeCal(); };
  $('cal').onclick = (ev) => {
    ev.stopPropagation();
    const b = ev.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.nav) {
      const first = S.sessions[0].slice(0, 7), last = S.sessions[S.sessions.length - 1].slice(0, 7);
      const next = shiftMonth(cal.month, +b.dataset.nav);
      cal.month = next < first ? first : next > last ? last : next;     // stay within the data's range
      drawCal();
    } else if (b.dataset.iso) {
      if (S.blindDate) setBlindDate(false);
      setDate(b.dataset.iso); $('note').textContent = ''; closeCal();
    }
  };
  document.addEventListener('click', closeCal);

  async function loadSlice() {
    const root = $('root').value, dte = $('dte').value, date = $('date').value;
    if (!date) return;
    if (S.pos && !confirm('Discard the open practice position (it is not journaled until closed)?')) return;
    S.pos = null;
    watchEnd(false);
    savePrefs();
    S.playing = false;
    overlay(`Slicing ${root} ${S.blindDate ? '(random day)' : date} ${dte}DTE from the archive… (first load of a session takes ~5–10 s; cached after)`);
    try {
      const [data, hist, jr, br, daily] = await Promise.all([
        getJson(`/api/slice?date=${date}&root=${root}&dte=${dte}&cadence=1s`),
        S.histDays > 0
          ? getJson(`/api/history?date=${date}&root=${root}&days=${S.histDays}`).catch(() => ({ days: [] }))
          : Promise.resolve({ days: [] }),
        getJson(`/api/journal?date=${date}&root=${root}`).catch(() => ({ trades: [] })),
        getJson(`/api/broker?date=${date}`).catch((e) => ({ trades: [], error: e.message })),
        getJson(`/api/daily?date=${date}&root=${root}&days=${DAILY_BARS}`).catch(() => ({ days: [] })),
      ]);
      S.daily = daily.days;
      S.data = data; S.meta = data.meta; S.hist = hist;
      S.journal = jr.trades; S.broker = br.trades; S.uploads = [];
      S.brokerNote = br.error ? `Real trades unavailable: ${br.error}` : `${br.trades.length} real round trip${br.trades.length === 1 ? '' : 's'} on ${date} from order_history.json (read-only).`;
      S.tradesVer++;
      $('timeline').min = S.meta.open_ms; $('timeline').max = S.meta.close_ms;
      drawRuler();
      prepare();
      S.clock = S.meta.open_ms;
      setMode('blind');
      updateSelection();
      for (const p of S.panes) { p.lock = null; p.R.fresh = true; p.chart && p.chart.remove(); p.chart = null; p.rebuild(); }
      showMeta();
      renderJournal(true);
      overlay(null);
      if (S.uploadFiles.length) refreshUploads();
      watchStart();
    } catch (e) {
      overlay(`No data: ${e.message}`);
      setTimeout(() => overlay(null), 4000);
    }
  }

  // ------------------------------------------------------------------ random-blind practice
  function setBlindDate(on) {
    S.blindDate = on;
    $('revealBtn').classList.toggle('hidden', !on);
    for (const id of ['prevDay', 'nextDay', 'dateBtn']) $(id).disabled = on;
    setDate($('date').value);
    if (S.meta) { showMeta(); S.tradesVer++; renderJournal(true); }
    for (const p of S.panes) if (p.chart) p.chart.applyOptions({ timeScale: { tickMarkFormatter: tickMark } });
  }
  async function randomSession() {
    if (!S.sessions.length) return toast('No sessions for this root/DTE', 'err');
    const pool = S.sessions.filter((d) => d !== $('date').value);
    const pick = pool[Math.floor(Math.random() * pool.length)] || S.sessions[0];
    $('note').textContent = '';
    setBlindDate(true);
    setDate(pick);
    await loadSlice();
    toast('Random session loaded — date hidden. Reveal when you\u2019re done.', 'ok');
  }
  function reveal() {
    setBlindDate(false);
    toast(`This was ${S.meta.session_date} (${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(S.meta.session_date + 'T00:00:00Z').getUTCDay()]})`, 'ok');
  }
  $('randomBtn').onclick = (ev) => { ev.target.blur(); randomSession(); };
  $('revealBtn').onclick = (ev) => { ev.target.blur(); reveal(); };

  // ------------------------------------------------------------------ input
  const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)
    && document.activeElement.type !== 'range';

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { $('help').classList.add('hidden'); closeCal(); document.activeElement.blur(); return; }
    if (!typing() && ev.ctrlKey && !ev.altKey && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
      ev.preventDefault();
      return jumpBy((ev.key === 'ArrowRight' ? 1 : -1) * (ev.shiftKey ? 300000 : 30000));
    }
    if (typing() || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const handled = {
      ' ': togglePlay,
      ArrowRight: () => step(1, ev.shiftKey), ArrowLeft: () => step(-1, ev.shiftKey),
      '[': () => setSpeed(S.speedIdx - 1), ']': () => setSpeed(S.speedIdx + 1),
      Home: () => seek(S.meta && S.meta.open_ms), End: () => seek(S.meta && S.meta.close_ms),
      ',': () => setOffset(S.offset - 1), '.': () => setOffset(S.offset + 1),
      ';': () => setQty(S.qty - 1), "'": () => setQty(S.qty + 1),
      c: () => openPos('C'), p: () => openPos('P'), x: () => closePos(), s: () => skipSetup(), n: () => zoneSkip(),
      v: () => setMode(S.mode === 'blind' ? 'review' : 'blind'),
      g: () => $('goto').focus(),
      r: () => randomSession(),
      j: () => { S.layout.journal = !S.layout.journal; applyColumns(); savePrefs(); },
      '?': () => $('help').classList.toggle('hidden'),
    }[ev.key];
    if (handled) { ev.preventDefault(); handled(); }
  });

  $('play').onclick = togglePlay;
  $('zoneBtn').onclick = (ev) => { ev.currentTarget.blur(); zoneSkip(); };
  function zoneChanged() {
    const k = Number($('zoneK').value);
    if (k >= 0.5 && k <= 5) S.zone.k = Math.round(k * 10) / 10;
    S.zone.lead = Number($('zoneLead').value) || 0;
    const big = Number($('zoneBig').value);
    if (big >= 0 && big <= 50) S.zone.big = Math.round(big * 10) / 10;
    $('zoneK').value = S.zone.k; $('zoneBig').value = S.zone.big;
    for (const id of ['zoneK', 'zoneLead', 'zoneBig']) $(id).blur();
    savePrefs();
    for (const p of S.panes) if (p.kind === 'chart' && p.ind.bands) p.rebuild();   // dashed ±k band
  }
  $('zoneK').onchange = zoneChanged;
  $('zoneLead').onchange = zoneChanged;
  $('zoneBig').onchange = zoneChanged;
  $('stepFwd').onclick = () => step(1);
  $('stepBack').onclick = () => step(-1);
  $('toOpen').onclick = () => seek(S.meta && S.meta.open_ms);
  $('slower').onclick = () => setSpeed(S.speedIdx - 1);
  $('faster').onclick = () => setSpeed(S.speedIdx + 1);
  $('mode').onclick = () => setMode(S.mode === 'blind' ? 'review' : 'blind');
  $('helpBtn').onclick = () => $('help').classList.toggle('hidden');
  $('journalBtn').onclick = (ev) => { ev.target.blur(); S.layout.journal = !S.layout.journal; applyColumns(); savePrefs(); };
  $('help').onclick = (ev) => { if (ev.target === $('help')) $('help').classList.add('hidden'); };
  $('offDn').onclick = (ev) => { ev.target.blur(); setOffset(S.offset - 1); };
  $('offUp').onclick = (ev) => { ev.target.blur(); setOffset(S.offset + 1); };
  $('qtyDn').onclick = (ev) => { ev.target.blur(); setQty(S.qty - 1); };
  $('qtyUp').onclick = (ev) => { ev.target.blur(); setQty(S.qty + 1); };
  $('buyCall').onclick = (ev) => { ev.target.blur(); openPos('C'); };
  $('buyPut').onclick = (ev) => { ev.target.blur(); openPos('P'); };
  $('closePos').onclick = (ev) => { ev.target.blur(); closePos(); };
  // Tape-measure ruler under the timeline: a tick every 5 min, longer at :15/:45, longer again at
  // :30, tallest (with a tiny hour number) on the hour. Positions follow the range input's thumb
  // travel (the thumb centre runs from THUMB/2 to width - THUMB/2).
  const THUMB = 16;
  function drawRuler() {
    const cv = $('ruler'), w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w || !h) return;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!S.meta) return;
    const css = getComputedStyle(document.documentElement);
    const lo = S.meta.open_ms, hi = S.meta.close_ms, STEP = 5 * 60000;
    const x = (ms) => THUMB / 2 + ((ms - lo) / (hi - lo)) * (w - THUMB);
    ctx.font = '9px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'top';
    for (let ms = Math.ceil(lo / STEP) * STEP; ms <= hi; ms += STEP) {
      const min = Math.round(ms / 60000) % 60;
      const len = min === 0 ? 9 : min === 30 ? 6 : min % 15 === 0 ? 4.5 : 2.5;
      const px = Math.round(x(ms)) + 0.5;
      ctx.strokeStyle = min === 0 ? css.getPropertyValue('--text') : css.getPropertyValue('--muted');
      ctx.globalAlpha = min === 0 ? 0.8 : 0.6;
      ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, len); ctx.stroke();
      if (min === 0) {
        ctx.globalAlpha = 0.7; ctx.fillStyle = css.getPropertyValue('--muted');
        const label = String(Math.round(ms / 3600000)), tw = ctx.measureText(label).width;
        ctx.fillText(label, px + 2 + tw > w ? px - 2 - tw : px + 2, 3);   // last hour: left of its tick
      }
    }
    ctx.globalAlpha = 1;
  }
  new ResizeObserver(drawRuler).observe($('ruler'));
  $('timeline').addEventListener('input', (ev) => seek(+ev.target.value));
  $('timeline').addEventListener('change', (ev) => ev.target.blur());
  $('goto').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    seek(E.parseClock(ev.target.value));
    ev.target.value = ''; ev.target.blur();
  });
  $('view').onchange = (ev) => { if (ev.target.value !== 'custom') applyView(ev.target.value); ev.target.blur(); };
  $('histDays').onchange = (ev) => {
    S.histDays = +ev.target.value; savePrefs(); ev.target.blur();
    if (S.data) loadSlice();                              // re-fetch history and rebuild (clock resets)
  };
  $('root').onchange = $('dte').onchange = async (ev) => { ev.target.blur(); if (S.blindDate) setBlindDate(false); await loadSessions(); };
  $('prevDay').onclick = () => shiftDay(-1);
  $('nextDay').onclick = () => shiftDay(1);
  $('load').onclick = (ev) => { ev.target.blur(); loadSlice(); };

  // ------------------------------------------------------------------ boot
  // Deep link: ?root=SPXW&dte=0&date=2026-08-28&t=10:32&mode=review&view=classic&speed=10&play=1
  (async function boot() {
    S.panes = [new Pane(0), new Pane(1)];
    for (const p of S.panes) {
      for (const iv of Object.keys(E.INTERVALS)) p.ivSel.add(new Option(iv, iv));
      p.srcSel.onchange = p.ivSel.onchange = (ev) => { ev.target.blur(); onPaneControl(p.i); };
    }
    for (const [k, v] of Object.entries(PRESETS)) $('view').add(new Option(v.label, k));
    $('view').add(new Option('Custom', 'custom'));

    const q = new URLSearchParams(location.search);
    const p = { ...loadPrefs(), ...Object.fromEntries(['root', 'dte', 'date', 'view'].filter((k) => q.has(k)).map((k) => [k, q.get(k)])) };
    $('root').value = p.root || 'SPXW';
    $('dte').value = p.dte || '0';
    if (Number.isInteger(p.speedIdx)) S.speedIdx = Math.max(0, Math.min(E.SPEEDS.length - 1, p.speedIdx));
    if (Number.isInteger(p.offset)) S.offset = p.offset;
    if (Number.isInteger(p.qty)) S.qty = Math.max(1, p.qty);
    if (Number.isInteger(p.histDays)) S.histDays = Math.max(0, Math.min(10, p.histDays));
    if (p.layout) S.layout = { ...S.layout, ...p.layout, hudW: Math.max(260, p.layout.hudW || 330) };
    if (p.show) S.show = { ...S.show, ...p.show };
    if (p.zone && p.zone.k > 0) S.zone = { k: +p.zone.k, lead: +p.zone.lead || 0, big: p.zone.big == null ? 3 : +p.zone.big };
    $('zoneK').value = S.zone.k; $('zoneLead').value = String(S.zone.lead); $('zoneBig').value = S.zone.big;
    if (p.jtab) S.jtab = p.jtab;
    if (p.jsort === 'asc' || p.jsort === 'desc') S.jsort = p.jsort;
    if (Array.isArray(p.paneInd)) p.paneInd.forEach((ind, i) => {
      if (S.panes[i] && ind) S.panes[i].ind = { ...defaultInd(), ...ind, ema: { ...defaultInd().ema, ...ind.ema }, bb: { ...defaultInd().bb, ...ind.bb } };
    });
    $('histDays').value = String(S.histDays);
    applyColumns();
    setDate(p.date || '');

    const view = p.view && (PRESETS[p.view] || p.view === 'custom') ? p.view : 'tv';
    if (view === 'custom' && Array.isArray(p.panes) && p.panes.length === 2) {
      S.view = 'custom'; $('view').value = 'custom';
      p.panes.forEach(([kind, iv], i) => S.panes[i].configure(kind, E.INTERVALS[iv] ? iv : '1m'));
    } else {
      applyView(view);
    }
    try {
      await loadSessions();
      if (!p.date && S.sessions.length) setDate(S.sessions[S.sessions.length - 1]);
      await loadSlice();
      if (S.data && q.has('t')) seek(E.parseClock(q.get('t')));
      if (S.data && q.get('mode') === 'review') setMode('review');
      if (S.data && q.has('speed')) { const i = E.SPEEDS.indexOf(+q.get('speed')); if (i >= 0) S.speedIdx = i; }
      if (S.data && q.get('play') === '1') S.playing = true;
    } catch (e) {
      overlay(`Server error: ${e.message}`);
    }
    requestAnimationFrame(frame);
  })();
})();
