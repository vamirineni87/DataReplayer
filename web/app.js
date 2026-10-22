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
  const TF_CHOICES = ['chart', '1s', '5s', '15s', '1m', '2m', '5m'];
  const defaultInd = () => ({
    vwap: true, bands: true, vp: true, vol: true,
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
        layout: S.layout, jtab: S.jtab, show: S.show,
      }));
    } catch (e) { /* private mode: prefs are a convenience only */ }
  }

  // ------------------------------------------------------------------ state
  const S = {
    data: null, meta: null, sessions: [], sessionSet: new Set(), byKey: new Map(),
    clock: 0, playing: false, speedIdx: 2, offset: 0, qty: 1,
    mode: 'blind',                       // always opens blind (operator preference)
    view: 'tv', histDays: 5, hist: { days: [] },
    ind: null, rowSize: 0.05, profileIdx: null, profile: null,
    sel: { key: '' }, panes: [],
    pos: null,                           // open practice position
    journal: [], broker: [], uploads: [], brokerNote: '', tradesVer: 0,
    jtab: 'practice', show: { practice: true, broker: true, upload: true },
    layout: { split: null, hudW: 280, jrW: 330, journal: true },
  };
  const speed = () => E.SPEEDS[S.speedIdx];
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

  // ------------------------------------------------------------------ panes
  let syncing = false, syncingCross = false;

  class Pane {
    constructor(i) {
      this.i = i; this.box = $(`pane${i}`); this.host = $(`chart${i}`); this.legendEl = $(`legend${i}`);
      this.srcSel = $(`src${i}`); this.ivSel = $(`iv${i}`); this.indEl = $(`ind${i}`);
      this.kind = 'chart'; this.iv = '1m'; this.ind = defaultInd();
      this.chart = null; this.layers = []; this.profile = null; this.hrows = []; this.vzoom = 1;
      this.hover = false; this.markerKey = '';
      this.R = { clock: null, k: -1, mode: '', sel: '', full: true, fresh: true };
      this.bindAxisZoom();
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
      this.keepRange = keepRange;
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
      this.chart.subscribeCrosshairMove((p) => this.onCrosshair(p));
      if (this.kind === 'chart') this.buildChart();
      else if (this.kind === 'underlying') this.buildUnderlying();
      else this.buildOptions();
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
      if (IND.vwap) {
        this.layers.push({ series: this.chart.addLineSeries(lineOpts(COLORS.vwap, { lineWidth: 2, title: 'VWAP', lastValueVisible: true })),
          full: (j) => val(vw[j]), partial: () => val(asOf(ind.vwap)), hist: (r) => val(r.vwap), key: 'vwap' });
      }
      if (IND.bands) {
        for (const k of BANDS) {
          for (const sign of [1, -1]) {
            const s = this.chart.addLineSeries(lineOpts(k === 2 ? COLORS.band2 : COLORS.band));
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
      const srcOf = (tf) => mtfSource(tf === 'chart' ? Idisp : E.INTERVALS[tf]);
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
              const r = orig();
              if (!r || !r.priceRange || this.vzoom === 1) return r;
              const { minValue: lo, maxValue: hi } = r.priceRange, mid = (lo + hi) / 2, h = ((hi - lo) / 2 || 0.01) * this.vzoom;
              return { ...r, priceRange: { minValue: mid - h, maxValue: mid + h } };
            },
          });
        } else if (L.series.options().priceScaleId !== 'vol') {
          // overlays never stretch the scale; VWAP/EMA count only while not zoomed
          L.series.applyOptions({ autoscaleInfoProvider: (orig) => (L.overlay || this.vzoom !== 1 ? null : orig()) });
        }
      }
    }
    bindAxisZoom() {
      const onAxis = (ev) => {
        if (!this.chart) return false;
        const rect = this.host.getBoundingClientRect();
        return ev.clientX > rect.right - this.chart.priceScale('right').width();
      };
      this.host.addEventListener('wheel', (ev) => {
        if (!onAxis(ev)) return;
        ev.preventDefault(); ev.stopPropagation();
        this.vzoom = Math.max(0.05, Math.min(20, this.vzoom * (ev.deltaY > 0 ? 1.12 : 1 / 1.12)));
        this.chart.priceScale('right').applyOptions({ autoScale: true });
        this.applyZoomProviders();
      }, { capture: true, passive: false });
      this.host.addEventListener('dblclick', (ev) => {
        if (!onAxis(ev)) return;
        this.vzoom = 1;
        this.chart.priceScale('right').applyOptions({ autoScale: true });
        this.applyZoomProviders();
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
      const vol = get('vol');
      if (vol && vol.value != null) h += `  V ${(vol.value / 1000).toFixed(1)}K`;
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
      const key = `${S.mode}|${revealed}|${S.tradesVer}|${reveal ? k : ''}|${S.pos ? S.pos.entry_t : ''}`;
      if (key === this.markerKey) return;
      this.markerKey = key;
      const m = S.meta, I = E.INTERVALS[this.iv];
      const timeOf = (ms) => E.chartTime(m.session_date, m.open_ms + Math.max(0, Math.min(this.b.n - 1, Math.floor((ms - m.open_ms) / I))) * I);
      let marks = [];
      for (const s of sets) marks = marks.concat(E.tradeMarkers(s.trades, S.clock, reveal, timeOf, MARKER_STYLE[s.kind]));
      if (S.pos && S.pos.entry_t <= S.clock) {
        marks.push({ time: timeOf(S.pos.entry_t), position: 'belowBar', shape: 'arrowUp', color: '#58a6ff',
          text: `${S.pos.type}${S.pos.strike} ×${S.pos.qty} @${S.pos.entry_mid.toFixed(2)}` });
      }
      if (reveal) marks.push({ time: this.times[k], position: 'aboveBar', color: '#d29922', shape: 'circle', text: 'now' });
      marks.sort((a, b) => a.time - b.time);
      this.main.setMarkers(marks);
    }

    // First view after a (re)build, anchored on the clock's bar k. No history -> that bar
    // mid-pane (at the open: the first bar centred); with history -> today's open near the left
    // edge so the day plays out rightward, unless the clock's bar would be off-screen.
    initialView(k) {
      const ts = this.chart.timeScale(), H = this.hrows.length, last = H + Math.max(0, k);
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
      if (rebuild || R.clock !== S.clock) {
        const T = this.times, H = this.hrows.length;
        const item = (j, x) => withTime(T[j], x);
        const ts = this.chart.timeScale();
        const prevRange = R.fresh ? null : (this.keepRange || ts.getVisibleLogicalRange());
        this.keepRange = null;

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
        if (rebuild && (R.fresh || R.mode !== S.mode)) this.initialView(k);
        else if (S.mode === 'blind') {
          if (rebuild && prevRange) ts.setVisibleLogicalRange(prevRange);   // setData shifts the view
          this.follow(prevRange, rebuild ? H + k : H + R.k, H + k);
          if (rebuild && prevRange && (H + k < prevRange.from || H + k > prevRange.to)) {
            const w = prevRange.to - prevRange.from;
            ts.setVisibleLogicalRange({ from: H + k - 0.8 * w, to: H + k + 0.2 * w });
          }
        }
        R.clock = S.clock; R.k = k; R.mode = S.mode; R.sel = sel; R.full = false; R.fresh = false;
        if (!this.hover) this.drawLegend(null);
      }
      this.updateMarkers(k);
    }
  }

  const withTime = (time, x) => (x ? { time, ...x } : { time });

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
    main.style.setProperty('--jr-w', `${S.layout.jrW}px`);
    main.classList.toggle('no-journal', !S.layout.journal);
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
    const right = r.right - (S.layout.journal ? S.layout.jrW + 5 : 0);
    S.layout.hudW = Math.round(Math.max(220, Math.min(520, right - e.clientX - 2)));
    applyColumns();
  });
  dragger($('vsplitJr'), (e) => {
    const r = $('main').getBoundingClientRect();
    S.layout.jrW = Math.round(Math.max(240, Math.min(720, r.right - e.clientX - 2)));
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

  async function openPos(type) {
    if (!S.data) return;
    const why = E.canOpen(S.pos, S.mode);
    if (why) return toast(why, 'err');
    const osi = S.sel[type];
    if (!osi) return toast(`No ${type === 'C' ? 'call' : 'put'} contract at this offset`, 'err');
    const q = quoteNow(osi);
    if (!q) return toast('No quote yet for that contract', 'err');
    const c = S.data.contracts[osi], t = S.clock;
    S.pos = { osi, type, strike: c.strike, qty: S.qty, entry_t: t, entry_mid: q.mid, offset: S.offset, exact: false };
    S.tradesVer++;
    toast(`BUY ${type} ${c.strike} ×${S.qty} @ ${q.mid.toFixed(2)} (mid) · ${E.fmtClock(t)}`, 'ok');
    try {
      const x = await exactQuote(osi, t);
      if (S.pos && S.pos.entry_t === t) {
        if (Math.abs(x.mid - S.pos.entry_mid) > 1e-9) toast(`Entry re-priced to exact tick: ${x.mid.toFixed(2)}`);
        S.pos.entry_mid = x.mid; S.pos.exact = true; S.tradesVer++;
      }
    } catch (e) { toast(`Exact re-price failed (${e.message}); keeping ${q.mid.toFixed(2)}`, 'err'); }
  }

  async function closePos() {
    if (!S.data) return;
    const why = E.canClose(S.pos);
    if (why) return toast(why, 'err');
    const pos = S.pos, t = S.clock;
    let q = quoteNow(pos.osi);
    try { q = await exactQuote(pos.osi, t); } catch (e) { toast(`Exact re-price failed (${e.message}); using 1s data`, 'err'); }
    if (!q) return toast('No bid available to close against', 'err');
    const c = S.data.contracts[pos.osi];
    const exc = E.excursion(c.t, c.bid, pos.entry_t, t, pos.entry_mid, pos.qty);
    const m = S.meta;
    const rec = {
      session_date: m.session_date, root: m.root, dte: m.dte, expiry: m.expiry, osi: pos.osi, strike: pos.strike,
      type: pos.type, qty: pos.qty, entry_t: pos.entry_t, entry_mid: pos.entry_mid, exit_t: t, exit_bid: q.bid,
      offset: pos.offset, mfe: Math.round(exc.mfe * 100) / 100, mae: Math.round(exc.mae * 100) / 100,
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
    if (S.show.broker) sets.push({ kind: 'broker', trades: S.broker.map((t) => ({ ...t, label: label(t) })) });
    if (S.show.upload) sets.push({ kind: 'upload', trades: S.uploads.map((t) => ({ ...t, label: label(t) })) });
    return sets;
  }
  const visibleInBlind = (t) => S.mode === 'review' || t.entry_t == null || t.entry_t <= S.clock;

  let lastJournalKey = '';
  function renderJournal(force) {
    const tab = S.jtab;
    const list = tab === 'practice' ? S.journal : tab === 'broker' ? S.broker : S.uploads;
    const shown = tab === 'practice' ? list : list.filter(visibleInBlind);
    const key = `${tab}|${S.tradesVer}|${shown.length}|${S.mode}|${S.show[tab]}|${S.pos ? 1 : 0}`;
    if (!force && key === lastJournalKey) return;
    lastJournalKey = key;
    for (const b of document.querySelectorAll('.jtabs button')) b.classList.toggle('active', b.dataset.tab === tab);
    $('jShow').checked = S.show[tab];
    $('jExport').classList.toggle('hidden', tab !== 'practice');

    const closed = shown.filter((t) => t.pnl != null);
    const net = closed.reduce((a, t) => a + t.pnl, 0), wins = closed.filter((t) => t.pnl > 0).length;
    $('jSum').innerHTML = `<span>${closed.length} trade${closed.length === 1 ? '' : 's'}</span>` +
      `<span>win ${closed.length ? Math.round((100 * wins) / closed.length) : 0}%</span>` +
      `<span class="${sgnCls(net)}"><b>${money(net)}</b></span>`;

    const rows = [];
    if (tab === 'practice' && S.pos) {
      rows.push(`<div class="jrow" data-t="${S.pos.entry_t}"><span class="c">OPEN ${S.pos.type} ${S.pos.strike} ×${S.pos.qty}</span>` +
        `<span class="p muted">live</span><span class="t">${E.fmtClock(S.pos.entry_t)} →</span><span class="px">${S.pos.entry_mid.toFixed(2)}</span></div>`);
    }
    for (const t of shown.slice().sort((a, b) => (b.entry_t ?? 0) - (a.entry_t ?? 0))) {
      const ep = t.entry_price ?? t.entry_mid, xp = t.exit_price ?? t.exit_bid;
      const name = tab === 'practice' ? `${t.type} ${t.strike} ×${t.qty}` : `${t.root || t.symbol} ${t.type || ''} ${t.strike ?? ''} ×${t.qty}`;
      const del = tab === 'practice' ? `<button class="del" data-del="${t.id}" title="Delete from journal">✕</button>` : '';
      rows.push(`<div class="jrow" data-t="${t.entry_t ?? ''}"><span class="c">${name}${t.unsaved ? ' <span class="neg">(unsaved)</span>' : ''}</span>` +
        `<span class="p ${sgnCls(t.pnl)}">${money(t.pnl)} ${del}</span>` +
        `<span class="t">${t.entry_t != null ? E.fmtClock(t.entry_t) : t.entry_ts ? t.entry_ts.slice(0, 10) : '—'} → ${t.exit_t != null ? E.fmtClock(t.exit_t) : t.exit_ts ? t.exit_ts.slice(0, 10) : 'open'}</span>` +
        `<span class="px">${f2(ep)} → ${f2(xp)}</span></div>`);
    }
    $('jList').innerHTML = rows.join('') || '<div class="jfoot muted">No trades.</div>';
    const hidden = list.length - shown.length;
    $('jFoot').textContent = (hidden > 0 ? `${hidden} later trade${hidden === 1 ? '' : 's'} hidden until the clock reaches them (BLIND). ` : '')
      + (tab === 'broker' ? (S.brokerNote || 'From order_history.json (read-only).') : '')
      + (tab === 'upload' ? 'Drop or upload an order_history-style JSON or a practice export.' : '');
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
    const row = ev.target.closest('.jrow');
    if (row && row.dataset.t) seek(+row.dataset.t);
  };
  for (const b of document.querySelectorAll('.jtabs button')) {
    b.onclick = () => { S.jtab = b.dataset.tab; savePrefs(); renderJournal(true); };
  }
  $('jShow').onchange = (ev) => { S.show[S.jtab] = ev.target.checked; S.tradesVer++; savePrefs(); ev.target.blur(); renderJournal(true); };
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

  async function uploadFile(file) {
    if (!S.meta) return toast('Load a session first', 'err');
    try {
      const obj = JSON.parse(await file.text());
      const r = await postJson(`/api/parse-trades?date=${S.meta.session_date}&name=${encodeURIComponent(file.name)}`, obj);
      S.uploads = S.uploads.filter((t) => t.source !== `upload:${file.name}`).concat(r.trades);
      S.tradesVer++; S.jtab = 'upload'; renderJournal(true);
      toast(`${file.name}: ${r.trades.length} round trip${r.trades.length === 1 ? '' : 's'} on ${S.meta.session_date}`, 'ok');
    } catch (e) { toast(`Upload failed: ${e.message}`, 'err'); }
  }
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
      const last = c.c[i], v = ind.vwap[i], sd = ind.sd[i];
      const z = sd > 0 ? (last - v) / sd : 0;
      $('chartPx').textContent = f2(last);
      $('vwapPx').textContent = `${f2(v)}  (${z >= 0 ? '+' : ''}${z.toFixed(2)}σ)`;
      $('vaInfo').textContent = `${f2(ind.val[i])} / ${f2(ind.poc[i])} / ${f2(ind.vah[i])}`;
    }
    $('rootPx').textContent = f2(S.sel.px);
    $('offset').textContent = S.offset > 0 ? `+${S.offset}` : `${S.offset}`;
    $('offsetLbl').textContent = S.offset === 0 ? 'ATM' : S.offset > 0 ? 'OTM' : 'ITM';
    $('qty').textContent = S.qty;
    quoteHud('c', S.sel.C, S.sel.kc);
    quoteHud('p', S.sel.P, S.sel.kp);
    const pos = S.pos;
    $('posBox').classList.toggle('hidden', !pos);
    const canTrade = S.mode === 'blind';
    $('buyCall').disabled = $('buyPut').disabled = !!pos || !canTrade;
    $('closePos').disabled = !pos;
    if (pos) {
      const q = quoteNow(pos.osi), c2 = S.data.contracts[pos.osi];
      const pnl = q ? E.optionPnl(pos.entry_mid, q.bid, pos.qty) : null;
      const exc = E.excursion(c2.t, c2.bid, pos.entry_t, S.clock, pos.entry_mid, pos.qty);
      $('posTitle').textContent = `LONG ${pos.type} ${pos.strike} ×${pos.qty}`;
      $('posHold').textContent = `${E.fmtClock(pos.entry_t)} · ${Math.round((S.clock - pos.entry_t) / 1000)}s`;
      $('posEntry').textContent = `${pos.entry_mid.toFixed(2)}${pos.exact ? '' : ' …'}`;
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
      const hudKey = `${S.clock}|${S.playing}|${S.speedIdx}|${S.offset}|${S.qty}|${S.sel.key}|${S.tradesVer}|${S.mode}`;
      if (hudKey !== lastHud) { hud(); lastHud = hudKey; }
      renderJournal();
    }
    requestAnimationFrame(frame);
  }

  const visibleIvs = () => S.panes.filter((p) => p.kind !== 'none').map((p) => E.INTERVALS[p.iv]);
  function seek(ms) {
    if (!S.data || ms == null) return;
    let t = Math.min(S.meta.close_ms, Math.max(S.meta.open_ms, ms));
    if (S.pos && t < S.pos.entry_t) {                // can't rewind past an open entry
      t = S.pos.entry_t;
      toast('In a position — can’t rewind before its entry (close it first)', 'err');
    }
    S.clock = t;
    for (const p of S.panes) p.R.full = true;      // rebuild prefix (also handles backwards seeks)
  }
  function step(dir, coarse) {
    if (!S.data) return;
    S.playing = false;
    const iv = coarse ? Math.max(...visibleIvs()) : Math.min(...visibleIvs());
    seek(E.stepBoundary(S.clock, iv, dir, S.meta.open_ms, S.meta.close_ms));
  }
  function setSpeed(i) { S.speedIdx = Math.max(0, Math.min(E.SPEEDS.length - 1, i)); savePrefs(); }
  function setMode(mode) {
    if (mode === 'review' && S.pos) return toast('Close the open position before REVIEW (it shows the future)', 'err');
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
    if (S.pos && !confirm('Discard the open practice position (it is not journaled until closed)?')) return;
    S.pos = null;
    savePrefs();
    S.playing = false;
    overlay(`Slicing ${root} ${date} ${dte}DTE from the archive… (first load of a session takes ~5–10 s; cached after)`);
    try {
      const [data, hist, jr, br] = await Promise.all([
        getJson(`/api/slice?date=${date}&root=${root}&dte=${dte}&cadence=1s`),
        S.histDays > 0
          ? getJson(`/api/history?date=${date}&root=${root}&days=${S.histDays}`).catch(() => ({ days: [] }))
          : Promise.resolve({ days: [] }),
        getJson(`/api/journal?date=${date}&root=${root}`).catch(() => ({ trades: [] })),
        getJson(`/api/broker?date=${date}`).catch((e) => ({ trades: [], error: e.message })),
      ]);
      S.data = data; S.meta = data.meta; S.hist = hist;
      S.journal = jr.trades; S.broker = br.trades; S.uploads = [];
      S.brokerNote = br.error ? `Real trades unavailable: ${br.error}` : `${br.trades.length} real round trip${br.trades.length === 1 ? '' : 's'} on ${date} from order_history.json (read-only).`;
      S.tradesVer++;
      $('timeline').min = S.meta.open_ms; $('timeline').max = S.meta.close_ms;
      prepare();
      S.clock = S.meta.open_ms;
      setMode('blind');
      updateSelection();
      for (const p of S.panes) { p.vzoom = 1; p.R.fresh = true; p.chart && p.chart.remove(); p.chart = null; p.rebuild(); }
      showMeta();
      renderJournal(true);
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
      ';': () => setQty(S.qty - 1), "'": () => setQty(S.qty + 1),
      c: () => openPos('C'), p: () => openPos('P'), x: () => closePos(),
      v: () => setMode(S.mode === 'blind' ? 'review' : 'blind'),
      g: () => $('goto').focus(),
      j: () => { S.layout.journal = !S.layout.journal; applyColumns(); savePrefs(); },
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
  $('journalBtn').onclick = (ev) => { ev.target.blur(); S.layout.journal = !S.layout.journal; applyColumns(); savePrefs(); };
  $('help').onclick = (ev) => { if (ev.target === $('help')) $('help').classList.add('hidden'); };
  $('offDn').onclick = (ev) => { ev.target.blur(); setOffset(S.offset - 1); };
  $('offUp').onclick = (ev) => { ev.target.blur(); setOffset(S.offset + 1); };
  $('qtyDn').onclick = (ev) => { ev.target.blur(); setQty(S.qty - 1); };
  $('qtyUp').onclick = (ev) => { ev.target.blur(); setQty(S.qty + 1); };
  $('buyCall').onclick = (ev) => { ev.target.blur(); openPos('C'); };
  $('buyPut').onclick = (ev) => { ev.target.blur(); openPos('P'); };
  $('closePos').onclick = (ev) => { ev.target.blur(); closePos(); };
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
    if (Number.isInteger(p.qty)) S.qty = Math.max(1, p.qty);
    if (Number.isInteger(p.histDays)) S.histDays = Math.max(0, Math.min(10, p.histDays));
    if (p.layout) S.layout = { ...S.layout, ...p.layout };
    if (p.show) S.show = { ...S.show, ...p.show };
    if (p.jtab) S.jtab = p.jtab;
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
