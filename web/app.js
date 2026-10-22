/* Replay UI: two configurable panes + master clock + HUD. Pure logic lives in engine.js.
 *
 * Each pane shows one SOURCE at its own interval:
 *   chart       stock trades of the chart symbol (SPY for SPXW): candles, volume, session VWAP
 *               ± σ bands, developing POC/VAH/VAL step lines, volume-profile histogram
 *   underlying  the option root's underlying (SPX for SPXW): candles
 *   options     the selected call/put mids (selection follows the as-of underlying)
 *   none        pane hidden
 * View presets just set both panes; changing a pane makes the view "custom".
 *
 * HISTORY: chart panes at 1m or coarser prepend N prior sessions (server-built 1m bars with
 * each day's own VWAP/σ, POC/VAH/VAL and final profile). They are entirely before the replayed
 * day, so they are always shown. EMA20 / Bollinger(20, 2) run through history into today.
 *
 * BLIND mode renders only what is known as of the clock (completed bars + the in-progress bar
 * built from samples t <= clock); REVIEW shows the whole session and marks the clock.
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
  const EMA_LEN = 20, BB_LEN = 20, BB_MULT = 2;
  const HIST_MIN_IV = 60000;            // history only on 1m-or-coarser chart panes

  // ------------------------------------------------------------------ prefs
  const PREFS_KEY = 'replayer.prefs.v2';
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { return {}; }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        root: $('root').value, dte: $('dte').value, date: $('date').value,
        speedIdx: S.speedIdx, offset: S.offset, view: S.view,
        panes: S.panes.map((p) => [p.kind, p.iv]), showBands: S.showBands, showVP: S.showVP,
        showEMA: S.showEMA, showBB: S.showBB, histDays: S.histDays,
      }));
    } catch (e) { /* private mode: prefs are a convenience only */ }
  }

  // ------------------------------------------------------------------ state
  const S = {
    data: null, meta: null, sessions: [], sessionSet: new Set(), byKey: new Map(),
    clock: 0, playing: false, speedIdx: 2, offset: 0,
    mode: 'blind',                       // always opens blind (operator preference)
    view: 'tv', showBands: true, showVP: true, showEMA: false, showBB: false,
    histDays: 5, hist: { days: [] },
    ind: null, rowSize: 0.05, profileIdx: null, profile: null,
    sel: { key: '' }, panes: [],
  };
  const speed = () => E.SPEEDS[S.speedIdx];
  const speedLabel = () => (S.speedIdx === E.SPEEDS.length - 1 ? 'Max' : `${speed()}×`);

  // ------------------------------------------------------------------ chart theme
  const theme = {
    layout: { background: { type: 'solid', color: '#0f1115' }, textColor: '#c9d1d9' },
    grid: { vertLines: { color: '#1b2029' }, horzLines: { color: '#1b2029' } },
    rightPriceScale: { borderColor: '#262c36', minimumWidth: 70, scaleMargins: { top: 0.08, bottom: 0.2 } },
    timeScale: { borderColor: '#262c36', timeVisible: true, rightOffset: 8 },
    crosshair: { mode: LC.CrosshairMode.Normal },
    autoSize: true,
  };
  const noAutoscale = { autoscaleInfoProvider: () => null };
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

  // Prior days bucketed to interval I: rows {time, bar, vwap, sd, poc, vah, val, si} plus one
  // whitespace separator per day so lines (VWAP, bands, VA) break between sessions.
  function historyRows(days, I) {
    const rows = [];
    for (const d of days) {
      let cur = null;
      for (let i = 0; i < d.t.length; i++) {
        const b = Math.floor((d.t[i] - d.open_ms) / I);
        if (!cur || cur.b !== b) {
          if (cur) rows.push(cur);
          cur = { b, time: E.chartTime(d.date, d.open_ms + b * I),
            bar: { open: d.o[i], high: d.h[i], low: d.l[i], close: d.c[i], volume: d.v[i] } };
        } else {
          cur.bar.high = Math.max(cur.bar.high, d.h[i]); cur.bar.low = Math.min(cur.bar.low, d.l[i]);
          cur.bar.close = d.c[i]; cur.bar.volume += d.v[i];
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

  // ------------------------------------------------------------------ panes
  let syncing = false;

  class Pane {
    constructor(i) {
      this.i = i; this.box = $(`pane${i}`); this.host = $(`chart${i}`);
      this.srcSel = $(`src${i}`); this.ivSel = $(`iv${i}`);
      this.kind = 'chart'; this.iv = '1m';
      this.chart = null; this.layers = []; this.profile = null; this.hrows = [];
      this.R = { clock: null, k: -1, mode: '', sel: '', full: true, fresh: true };
    }

    configure(kind, iv) {
      this.kind = kind; this.iv = iv;
      this.srcSel.value = kind; this.ivSel.value = iv;
      this.box.classList.toggle('hidden', kind === 'none');
      this.box.style.flex = kind === 'options' ? '0.6 1 0' : '1 1 0';
      this.rebuild();
    }

    destroy() { if (this.chart) this.chart.remove(); this.chart = null; this.layers = []; this.profile = null; this.hrows = []; }

    rebuild() {
      this.destroy();
      this.R.full = true; this.R.fresh = true;
      if (this.kind === 'none' || !S.data) return;
      const m = S.meta, I = E.INTERVALS[this.iv];
      const srcT = this.kind === 'chart' ? S.data.chart.t : S.data.underlying.t;
      this.b = E.buildBuckets(srcT, m.open_ms, m.close_ms, I);
      this.times = this.b.starts.map((ms) => E.chartTime(m.session_date, ms));
      this.hrows = this.kind === 'chart' && I >= HIST_MIN_IV ? historyRows(S.hist.days, I) : [];
      this.chart = LC.createChart(this.host, {
        ...theme,
        // We manage the view ourselves (follow mode); the library's auto-shift would march bars left.
        timeScale: { ...theme.timeScale, secondsVisible: I < 60000, barSpacing: I === 1000 ? 3 : 6, minBarSpacing: 0.3,
          shiftVisibleRangeOnNewBar: false },
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
      if (this.kind === 'chart') this.buildChart();
      else if (this.kind === 'underlying') this.buildUnderlying();
      else this.buildOptions();
      for (const L of this.layers) {
        const h = L.hist;
        L.histData = h ? this.hrows.map((r) => (r.sep ? { time: r.time } : withTime(r.time, h(r)))) : [];
      }
      S.profileIdx = null;                                   // re-push profiles to new primitives
    }

    candleSeries() {
      return this.chart.addCandlestickSeries({
        upColor: COLORS.up, downColor: COLORS.down, wickUpColor: COLORS.up, wickDownColor: COLORS.down, borderVisible: false,
      });
    }

    buildChart() {
      const c = S.data.chart, b = this.b, ind = S.ind;
      const bars = E.fullOhlcv(c, b);
      const closes = (arr) => E.bucketCloseValues(c.t, arr, b);
      const asOf = (arr) => E.valueAsOf(c.t, arr, S.clock);
      const vw = closes(ind.vwap), sd = closes(ind.sd);
      const candles = this.candleSeries();
      const vol = this.chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
      this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 }, visible: false });
      const volItem = (x) => x && { value: x.volume, color: x.close >= x.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)' };
      const ohlc = (x) => x && { open: x.open, high: x.high, low: x.low, close: x.close };
      const val = (v) => (v == null ? null : { value: v });
      const partialBar = (k) => E.ohlcvAsOf(c, b, k, S.clock);

      this.layers = [
        { series: candles, full: (j) => ohlc(bars[j]), partial: (k) => ohlc(partialBar(k)), hist: (r) => ohlc(r.bar) },
        { series: vol, full: (j) => volItem(bars[j]), partial: (k) => volItem(partialBar(k)), hist: (r) => volItem(r.bar) },
        { series: this.chart.addLineSeries(lineOpts(COLORS.vwap, { lineWidth: 2, title: 'VWAP', lastValueVisible: true })),
          full: (j) => val(vw[j]), partial: () => val(asOf(ind.vwap)), hist: (r) => val(r.vwap) },
      ];
      this.bandSeries = [];
      for (const k of BANDS) {
        for (const sign of [1, -1]) {
          const s = this.chart.addLineSeries(lineOpts(k === 2 ? COLORS.band2 : COLORS.band, noAutoscale));
          this.bandSeries.push(s);
          this.layers.push({
            series: s,
            full: (j) => (vw[j] == null ? null : { value: vw[j] + sign * k * sd[j] }),
            partial: () => { const v = asOf(ind.vwap); return v == null ? null : { value: v + sign * k * asOf(ind.sd) }; },
            hist: (r) => ({ value: r.vwap + sign * k * r.sd }),
          });
        }
      }
      this.vpSeries = [];
      for (const [key, color, title] of [['poc', COLORS.poc, 'POC'], ['vah', COLORS.va, 'VAH'], ['val', COLORS.va, 'VAL']]) {
        const arr = ind[key];
        const s = this.chart.addLineSeries(lineOpts(color, { ...noAutoscale, lineType: LC.LineType.WithSteps, title, lastValueVisible: true }));
        const cl = closes(arr);
        this.vpSeries.push(s);
        this.layers.push({ series: s, full: (j) => val(cl[j]), partial: () => val(asOf(arr)), hist: (r) => val(r[key]) });
      }

      // EMA / Bollinger over one close sequence: history bars, then today's buckets.
      const H = this.hrows.filter((r) => !r.sep).length;
      const seq = this.hrows.filter((r) => !r.sep).map((r) => r.bar.close).concat(bars.map((x) => (x ? x.close : null)));
      const ema = E.emaSeries(seq, EMA_LEN), bb = E.bbSeries(seq, BB_LEN, BB_MULT);
      const liveClose = (k) => { const x = partialBar(k); return x ? x.close : null; };
      const liveBB = (k) => {
        const cl = liveClose(k);
        if (cl == null) return null;
        const win = E.lastValues(seq, H + k - 1, BB_LEN - 1).concat([cl]);
        return win.length === BB_LEN ? E.bbOf(win, BB_MULT) : null;
      };
      const emaS = this.chart.addLineSeries(lineOpts(COLORS.ema, { lineWidth: 1, title: `EMA${EMA_LEN}`, lastValueVisible: true }));
      this.layers.push({
        series: emaS,
        full: (j) => (seq[H + j] == null ? null : val(ema[H + j])),
        partial: (k) => val(E.emaStep(H + k > 0 ? ema[H + k - 1] : null, liveClose(k), EMA_LEN)),
        hist: (r) => val(ema[r.si]),
      });
      this.bbSeries = [];
      for (const [key, color, style] of [['up', COLORS.bb, 0], ['mid', COLORS.bbMid, 2], ['lo', COLORS.bb, 0]]) {
        const s = this.chart.addLineSeries(lineOpts(color, { ...noAutoscale, lineStyle: style }));
        this.bbSeries.push(s);
        this.layers.push({
          series: s,
          full: (j) => (bb[H + j] ? { value: bb[H + j][key] } : null),
          partial: (k) => { const x = liveBB(k); return x ? { value: x[key] } : null; },
          hist: (r) => (bb[r.si] ? { value: bb[r.si][key] } : null),
        });
      }
      this.emaSeries = emaS;

      this.profile = new ProfilePrimitive();
      candles.attachPrimitive(this.profile);
      this.histProfiles = this.hrows.length ? historyProfiles(S.hist.days, S.rowSize) : [];
      this.applyToggles();
    }

    buildUnderlying() {
      const u = S.data.underlying, b = this.b;
      const bars = E.fullBars(u.p, b);
      this.layers = [{
        series: this.candleSeries(),
        full: (j) => bars[j],
        partial: (k) => E.barAsOf(u.t, u.p, b, k, S.clock),
      }];
    }

    buildOptions() {
      this.callLine = this.chart.addLineSeries(lineOpts(COLORS.call, { lineWidth: 2, title: 'C mid', lastValueVisible: true }));
      this.putLine = this.chart.addLineSeries(lineOpts(COLORS.put, { lineWidth: 2, title: 'P mid', lastValueVisible: true }));
      this.optCache = new Map();
      this.setOptionLayers();
    }

    setOptionLayers() {
      const layer = (series, osi) => {
        if (!osi) return { series, full: () => null, partial: () => null };
        if (!this.optCache.has(osi)) {
          const c = S.data.contracts[osi];
          this.optCache.set(osi, E.bucketCloseValues(c.t, c.mid, this.b));
        }
        const cl = this.optCache.get(osi), c = S.data.contracts[osi];
        return {
          series,
          full: (j) => (cl[j] == null ? null : { value: cl[j] }),
          partial: () => { const v = E.valueAsOf(c.t, c.mid, S.clock); return v == null ? null : { value: v }; },
        };
      };
      this.layers = [layer(this.callLine, S.sel.C), layer(this.putLine, S.sel.P)];
      for (const L of this.layers) L.histData = [];
    }

    applyToggles() {
      if (this.kind !== 'chart' || !this.chart) return;
      for (const s of this.bandSeries) s.applyOptions({ visible: S.showBands });
      for (const s of this.vpSeries) s.applyOptions({ visible: S.showVP });
      for (const s of this.bbSeries) s.applyOptions({ visible: S.showBB });
      this.emaSeries.applyOptions({ visible: S.showEMA });
      this.profile.visible = S.showVP;
      this.profile.set(this.profile.profiles);
    }

    setProfile(today) {
      if (!this.profile) return;
      const live = today && { ...today, t0: this.times[0], live: true };
      this.profile.set(this.histProfiles.concat(live ? [live] : []));
    }

    // First view after a (re)build: no history -> today's first bar mid-pane; with history ->
    // today's open near the left edge (a few prior bars visible), the day to play out rightward.
    initialView() {
      const ts = this.chart.timeScale(), H = this.hrows.length;
      const n = Math.max(20, Math.floor(ts.width() / (E.INTERVALS[this.iv] === 1000 ? 3 : 6)));
      if (S.mode === 'review') {
        if (H) ts.setVisibleLogicalRange({ from: H - 5, to: H + this.times.length + 5 });
        else ts.fitContent();
      } else if (H) {
        ts.setVisibleLogicalRange({ from: H - 8, to: H - 8 + n });
      } else {
        ts.setVisibleLogicalRange({ from: -n / 2, to: n / 2 });
      }
    }

    // Follow the newest bar while the operator is watching it: once it reaches the right edge,
    // slide the window. If they've scrolled away (e.g. studying history), leave the view alone.
    follow(prevRange, prevLast, last) {
      if (!prevRange) return;
      const ts = this.chart.timeScale(), w = prevRange.to - prevRange.from;
      const watching = prevLast >= prevRange.from - 1 && prevLast <= prevRange.to + 1;
      if (!watching) return;
      if (last > prevRange.to - 3) ts.setVisibleLogicalRange({ from: last + 3 - w, to: last + 3 });
      else if (last < prevRange.from) ts.setVisibleLogicalRange({ from: last - 0.8 * w, to: last + 0.2 * w });
    }

    render() {
      if (!this.chart) return;
      const R = this.R, k = E.bucketOf(this.b, S.clock);
      const sel = this.kind === 'options' ? S.sel.key : '';
      if (sel !== R.sel && this.kind === 'options') this.setOptionLayers();
      const rebuild = R.full || R.mode !== S.mode || R.sel !== sel || (S.mode === 'blind' && k < R.k);
      if (!rebuild && R.clock === S.clock) return;
      const T = this.times, H = this.hrows.length;
      const item = (j, x) => withTime(T[j], x);
      const ts = this.chart.timeScale();
      const prevRange = R.fresh ? null : ts.getVisibleLogicalRange();

      if (S.mode === 'review') {
        if (rebuild) for (const L of this.layers) L.series.setData(L.histData.concat(T.map((_, j) => item(j, L.full(j)))));
      } else if (rebuild) {
        for (const L of this.layers) {
          const out = new Array(k + 1);
          for (let j = 0; j < k; j++) out[j] = item(j, L.full(j));
          out[k] = item(k, L.partial(k));
          L.series.setData(L.histData.concat(out));
        }
      } else {
        for (const L of this.layers) {
          for (let j = R.k; j < k; j++) L.series.update(item(j, L.full(j)));   // finalize passed bars
          L.series.update(item(k, L.partial(k)));
        }
      }
      const first = this.layers[0] && this.layers[0].series;
      if (first && this.kind !== 'options') {
        first.setMarkers(S.mode === 'review'
          ? [{ time: T[k], position: 'aboveBar', color: '#d29922', shape: 'arrowDown', text: 'now' }] : []);
      }
      if (rebuild && (R.fresh || R.mode !== S.mode)) this.initialView();
      else if (S.mode === 'blind') {
        if (rebuild && prevRange) ts.setVisibleLogicalRange(prevRange);   // setData shifts the view
        // after a seek, bring the newest bar into view even if it was off-screen
        this.follow(prevRange, rebuild ? H + k : H + R.k, H + k);
        if (rebuild && prevRange && (H + k < prevRange.from || H + k > prevRange.to)) {
          const w = prevRange.to - prevRange.from;
          ts.setVisibleLogicalRange({ from: H + k - 0.8 * w, to: H + k + 0.2 * w });
        }
      }
      R.clock = S.clock; R.k = k; R.mode = S.mode; R.sel = sel; R.full = false; R.fresh = false;
    }
  }

  const withTime = (time, x) => (x ? { time, ...x } : { time });

  // ------------------------------------------------------------------ data prep
  function prepare() {
    const m = S.meta, c = S.data.chart;
    S.byKey.clear();
    for (const [osi, ct] of Object.entries(S.data.contracts)) S.byKey.set(`${ct.type}|${ct.strike}`, osi);
    S.rowSize = m.vp_row_size || 0.05;
    const vp = E.profileSeries(c, S.rowSize);
    S.ind = { ...E.vwapSeries(c), poc: vp.poc, vah: vp.vah, val: vp.val };
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
    if (!S.showVP || !S.panes.some((p) => p.profile)) return;
    const c = S.data.chart;
    const idx = S.mode === 'review' ? c.t.length - 1 : E.asOfIndex(c.t, S.clock);
    if (idx === S.profileIdx) return;
    S.profileIdx = idx;
    S.profile = E.profileAsOf(c, S.rowSize, idx);
    for (const p of S.panes) p.setProfile(S.profile);
  }

  // ------------------------------------------------------------------ HUD
  const f2 = (x) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(2));
  function quoteHud(prefix, osi, strike) {
    if (!osi) {
      $(prefix + 'Strike').textContent = strike != null ? `${strike} (no data)` : '—';
      for (const f of ['Bid', 'Mid', 'Ask']) $(prefix + f).textContent = '—';
      $(prefix + 'Age').textContent = '';
      return;
    }
    const c = S.data.contracts[osi];
    const i = E.asOfIndex(c.t, S.clock);
    $(prefix + 'Strike').textContent = `${c.strike}`;
    $(prefix + 'Bid').textContent = i < 0 ? '—' : f2(c.bid[i]);
    $(prefix + 'Mid').textContent = i < 0 ? '—' : f2(c.mid[i]);
    $(prefix + 'Ask').textContent = i < 0 ? '—' : f2(c.ask[i]);
    $(prefix + 'Age').textContent = i < 0 ? 'no quote yet' : `quote age ${((S.clock - c.t[i]) / 1000).toFixed(1)}s`;
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
      const last = c.c[i], v = ind.vwap[i], sd = ind.sd[i];
      const z = sd > 0 ? (last - v) / sd : 0;
      $('chartPx').textContent = f2(last);
      $('vwapPx').textContent = `${f2(v)}  (${z >= 0 ? '+' : ''}${z.toFixed(2)}σ)`;
      $('vaInfo').textContent = `${f2(ind.val[i])} / ${f2(ind.poc[i])} / ${f2(ind.vah[i])}`;
    }
    $('rootPx').textContent = f2(S.sel.px);
    $('offset').textContent = S.offset === 0 ? '0 (ATM)' : `${S.offset > 0 ? '+' : ''}${S.offset} (${S.offset > 0 ? 'OTM' : 'ITM'})`;
    quoteHud('c', S.sel.C, S.sel.kc);
    quoteHud('p', S.sel.P, S.sel.kp);
    $('play').innerHTML = S.playing ? '&#x23F8;' : '&#x25B6;';
    if (document.activeElement !== $('timeline')) $('timeline').value = S.clock;
  }

  function showMeta() {
    const m = S.meta;
    $('meta').textContent =
      `${m.root} ${m.session_date} · ${m.dte}DTE → exp ${m.expiry}\n` +
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
      updateSelection();
      updateProfile();
      for (const p of S.panes) p.render();
      const hudKey = `${S.clock}|${S.playing}|${S.speedIdx}|${S.offset}|${S.sel.key}`;
      if (hudKey !== lastHud) { hud(); lastHud = hudKey; }
    }
    requestAnimationFrame(frame);
  }

  const visibleIvs = () => S.panes.filter((p) => p.kind !== 'none').map((p) => E.INTERVALS[p.iv]);
  function seek(ms) {
    if (!S.data || ms == null) return;
    S.clock = Math.min(S.meta.close_ms, Math.max(S.meta.open_ms, ms));
    for (const p of S.panes) p.R.full = true;      // rebuild prefix (also handles backwards seeks)
  }
  function step(dir, coarse) {
    if (!S.data) return;
    S.playing = false;
    const iv = coarse ? Math.max(...visibleIvs()) : Math.min(...visibleIvs());
    S.clock = E.stepBoundary(S.clock, iv, dir, S.meta.open_ms, S.meta.close_ms);
  }
  function setSpeed(i) { S.speedIdx = Math.max(0, Math.min(E.SPEEDS.length - 1, i)); savePrefs(); }
  function setOffset(o) {
    const w = S.meta ? S.meta.strike_window : 15;
    S.offset = Math.max(-w, Math.min(w, o)); savePrefs();
  }
  function setMode(mode) {
    S.mode = mode;
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
  async function getJson(url) {
    const r = await fetch(url);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  }

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
      setDate(b.dataset.iso); $('note').textContent = ''; closeCal();
    }
  };
  document.addEventListener('click', closeCal);

  async function loadSlice() {
    const root = $('root').value, dte = $('dte').value, date = $('date').value;
    if (!date) return;
    savePrefs();
    S.playing = false;
    overlay(`Slicing ${root} ${date} ${dte}DTE from the archive… (first load of a session takes ~5–10 s; cached after)`);
    try {
      const [data, hist] = await Promise.all([
        getJson(`/api/slice?date=${date}&root=${root}&dte=${dte}&cadence=1s`),
        S.histDays > 0
          ? getJson(`/api/history?date=${date}&root=${root}&days=${S.histDays}`).catch(() => ({ days: [] }))
          : Promise.resolve({ days: [] }),
      ]);
      S.data = data; S.meta = data.meta; S.hist = hist;
      $('timeline').min = S.meta.open_ms; $('timeline').max = S.meta.close_ms;
      prepare();
      S.clock = S.meta.open_ms;
      setMode('blind');
      updateSelection();
      for (const p of S.panes) p.rebuild();
      showMeta();
      overlay(null);
    } catch (e) {
      overlay(`No data: ${e.message}`);
      setTimeout(() => overlay(null), 4000);
    }
  }

  // ------------------------------------------------------------------ input
  const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)
    && document.activeElement.type !== 'range';

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { $('help').classList.add('hidden'); closeCal(); document.activeElement.blur(); return; }
    if (typing() || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const handled = {
      ' ': togglePlay,
      ArrowRight: () => step(1, ev.shiftKey), ArrowLeft: () => step(-1, ev.shiftKey),
      '[': () => setSpeed(S.speedIdx - 1), ']': () => setSpeed(S.speedIdx + 1),
      Home: () => seek(S.meta && S.meta.open_ms), End: () => seek(S.meta && S.meta.close_ms),
      ',': () => setOffset(S.offset - 1), '.': () => setOffset(S.offset + 1),
      v: () => setMode(S.mode === 'blind' ? 'review' : 'blind'),
      g: () => $('goto').focus(),
      '?': () => $('help').classList.toggle('hidden'),
    }[ev.key];
    if (handled) { ev.preventDefault(); handled(); }
  });

  $('play').onclick = togglePlay;
  $('stepFwd').onclick = () => step(1);
  $('stepBack').onclick = () => step(-1);
  $('toOpen').onclick = () => seek(S.meta && S.meta.open_ms);
  $('slower').onclick = () => setSpeed(S.speedIdx - 1);
  $('faster').onclick = () => setSpeed(S.speedIdx + 1);
  $('mode').onclick = () => setMode(S.mode === 'blind' ? 'review' : 'blind');
  $('helpBtn').onclick = () => $('help').classList.toggle('hidden');
  $('help').onclick = (ev) => { if (ev.target === $('help')) $('help').classList.add('hidden'); };
  $('timeline').addEventListener('input', (ev) => seek(+ev.target.value));
  $('timeline').addEventListener('change', (ev) => ev.target.blur());
  $('goto').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    seek(E.parseClock(ev.target.value));
    ev.target.value = ''; ev.target.blur();
  });
  $('view').onchange = (ev) => { if (ev.target.value !== 'custom') applyView(ev.target.value); ev.target.blur(); };
  $('bands').onchange = (ev) => { S.showBands = ev.target.checked; S.panes.forEach((p) => p.applyToggles()); savePrefs(); ev.target.blur(); };
  const toggle = (id, key) => {
    $(id).onchange = (ev) => { S[key] = ev.target.checked; S.panes.forEach((p) => p.applyToggles()); savePrefs(); ev.target.blur(); };
  };
  toggle('ema', 'showEMA');
  toggle('bb', 'showBB');
  $('histDays').onchange = (ev) => {
    S.histDays = +ev.target.value; savePrefs(); ev.target.blur();
    if (S.data) loadSlice();                              // re-fetch history and rebuild (clock resets)
  };
  $('vp').onchange = (ev) => {
    S.showVP = ev.target.checked; S.profileIdx = null;
    S.panes.forEach((p) => p.applyToggles()); savePrefs(); ev.target.blur();
  };
  $('root').onchange = $('dte').onchange = async (ev) => { ev.target.blur(); await loadSessions(); };
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
    if (typeof p.showBands === 'boolean') S.showBands = p.showBands;
    if (typeof p.showVP === 'boolean') S.showVP = p.showVP;
    if (typeof p.showEMA === 'boolean') S.showEMA = p.showEMA;
    if (typeof p.showBB === 'boolean') S.showBB = p.showBB;
    if (Number.isInteger(p.histDays)) S.histDays = Math.max(0, Math.min(10, p.histDays));
    $('bands').checked = S.showBands; $('vp').checked = S.showVP;
    $('ema').checked = S.showEMA; $('bb').checked = S.showBB; $('histDays').value = String(S.histDays);
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
