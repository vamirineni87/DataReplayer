/* Replay UI (Phase 2): charts + master clock + HUD. Pure logic lives in engine.js.
 *
 * BLIND mode renders only what is known as of the clock (completed bars + the in-progress
 * bar built from samples t <= clock). REVIEW mode shows the whole session and marks the
 * clock. Every price in the HUD is an as-of read.
 */
(function () {
  'use strict';
  const E = window.Engine;
  const LC = window.LightweightCharts;
  const $ = (id) => document.getElementById(id);

  // ------------------------------------------------------------------ prefs
  const PREFS_KEY = 'replayer.prefs.v1';
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (e) { return {}; }
  }
  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({
        root: $('root').value, dte: $('dte').value, date: $('date').value,
        interval: S.intervalKey, speedIdx: S.speedIdx, offset: S.offset,
      }));
    } catch (e) { /* private mode: prefs are a convenience only */ }
  }

  // ------------------------------------------------------------------ state
  const S = {
    data: null, meta: null, sessions: [],
    clock: 0, playing: false, speedIdx: 2, intervalKey: '1m', offset: 0,
    mode: 'blind',                       // always opens blind (operator preference)
    buckets: null, bars: null, times: null, optCloses: new Map(), byKey: new Map(),
    rendered: { clock: null, k: -1, ko: -1, sel: '', mode: '', full: true },
  };
  const speed = () => E.SPEEDS[S.speedIdx];
  const speedLabel = () => (S.speedIdx === E.SPEEDS.length - 1 ? 'Max' : `${speed()}×`);

  // ------------------------------------------------------------------ charts
  const theme = {
    layout: { background: { type: 'solid', color: '#0f1115' }, textColor: '#c9d1d9' },
    grid: { vertLines: { color: '#1b2029' }, horzLines: { color: '#1b2029' } },
    rightPriceScale: { borderColor: '#262c36', minimumWidth: 70 },
    timeScale: { borderColor: '#262c36', timeVisible: true, secondsVisible: true, rightOffset: 8, barSpacing: 8 },
    crosshair: { mode: LC.CrosshairMode.Normal },
    autoSize: true,
  };
  const chartU = LC.createChart($('chartU'), { ...theme, timeScale: { ...theme.timeScale, visible: false } });
  const chartO = LC.createChart($('chartO'), theme);
  const candles = chartU.addCandlestickSeries({
    upColor: '#3fb950', downColor: '#f85149', wickUpColor: '#3fb950', wickDownColor: '#f85149', borderVisible: false,
  });
  const callLine = chartO.addLineSeries({ color: '#3fb950', lineWidth: 2, title: 'C mid', priceLineVisible: false });
  const putLine = chartO.addLineSeries({ color: '#f85149', lineWidth: 2, title: 'P mid', priceLineVisible: false });

  // Both panes share the same bucket grid, so logical ranges line up 1:1.
  let syncing = false;
  function sync(from, to) {
    from.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (syncing || !r) return;
      syncing = true; to.timeScale().setVisibleLogicalRange(r); syncing = false;
    });
  }
  sync(chartU, chartO); sync(chartO, chartU);

  // ------------------------------------------------------------------ data prep
  function prepare() {
    const m = S.meta, u = S.data.underlying;
    const I = E.INTERVALS[S.intervalKey];
    S.buckets = E.buildBuckets(u.t, m.open_ms, m.close_ms, I);
    S.bars = E.fullBars(u.p, S.buckets);
    S.times = S.buckets.starts.map((ms) => E.chartTime(m.session_date, ms));
    S.optCloses.clear();
    S.byKey.clear();
    for (const [osi, c] of Object.entries(S.data.contracts)) S.byKey.set(`${c.type}|${c.strike}`, osi);
    S.rendered.full = true;
  }

  function optCloses(osi) {
    if (!S.optCloses.has(osi)) {
      const c = S.data.contracts[osi];
      S.optCloses.set(osi, E.bucketCloseValues(c.t, c.mid, S.buckets));
    }
    return S.optCloses.get(osi);
  }

  // Selected contracts follow the as-of underlying (live tool semantics), C and P.
  function selection() {
    const u = S.data.underlying;
    const px = E.valueAsOf(u.t, u.p, S.clock);
    if (px == null) return { px: null, C: null, P: null };
    const strikes = S.meta.strikes;
    const kc = E.pickStrike(strikes, px, 'C', S.offset), kp = E.pickStrike(strikes, px, 'P', S.offset);
    return { px, C: S.byKey.get(`C|${kc}`) || null, P: S.byKey.get(`P|${kp}`) || null, kc, kp };
  }

  // ------------------------------------------------------------------ rendering
  const ws = (k) => ({ time: S.times[k] });
  const candleAt = (k, bar) => (bar ? { time: S.times[k], ...bar } : ws(k));
  const pointAt = (k, v) => (v == null ? ws(k) : { time: S.times[k], value: v });

  function partialBar(k) {
    const u = S.data.underlying;
    return candleAt(k, E.barAsOf(u.t, u.p, S.buckets, k, S.clock));
  }
  function partialPoint(osi, k) {
    const c = S.data.contracts[osi];
    return pointAt(k, E.valueAsOf(c.t, c.mid, S.clock));
  }

  function lineData(osi, k) {
    if (!osi) return [];
    const closes = optCloses(osi);
    if (S.mode === 'review') return closes.map((v, j) => pointAt(j, v));
    const out = new Array(k + 1);
    for (let j = 0; j < k; j++) out[j] = pointAt(j, closes[j]);
    out[k] = partialPoint(osi, k);
    return out;
  }

  function render(force) {
    if (!S.data) return;
    const R = S.rendered, k = E.bucketOf(S.buckets, S.clock);
    const sel = selection();
    const selKey = `${sel.C}|${sel.P}`;
    if (!force && !R.full && R.clock === S.clock && R.sel === selKey && R.mode === S.mode) return;

    let view = null;              // 'fit' | 'scroll' — applied after both panes have data
    // Underlying candles
    if (S.mode === 'review') {
      if (R.full || R.mode !== 'review') {
        candles.setData(S.bars.map((b, j) => candleAt(j, b)));
        view = 'fit';
      }
      candles.setMarkers([{ time: S.times[k], position: 'aboveBar', color: '#d29922', shape: 'arrowDown', text: 'now' }]);
    } else if (R.full || R.mode !== 'blind' || k < R.k) {
      const out = new Array(k + 1);
      for (let j = 0; j < k; j++) out[j] = candleAt(j, S.bars[j]);
      out[k] = partialBar(k);
      candles.setMarkers([]);
      candles.setData(out);
      view = 'scroll';
    } else {
      for (let j = R.k; j < k; j++) candles.update(candleAt(j, S.bars[j]));   // finalize passed bars
      candles.update(partialBar(k));
    }

    // Option lines (selected C and P)
    const selChanged = R.sel !== selKey;
    for (const [series, osi] of [[callLine, sel.C], [putLine, sel.P]]) {
      if (S.mode === 'review') {
        if (R.full || R.mode !== 'review' || selChanged) series.setData(lineData(osi, k));
      } else if (R.full || R.mode !== 'blind' || selChanged || k < R.k) {
        series.setData(lineData(osi, k));
      } else if (osi) {
        const closes = optCloses(osi);
        for (let j = R.k; j < k; j++) series.update(pointAt(j, closes[j]));
        series.update(partialPoint(osi, k));
      }
    }

    if (view === 'fit') { chartU.timeScale().fitContent(); chartO.timeScale().fitContent(); }
    if (view === 'scroll') { chartU.timeScale().scrollToRealTime(); chartO.timeScale().scrollToRealTime(); }

    R.clock = S.clock; R.k = k; R.sel = selKey; R.mode = S.mode; R.full = false;
    hud(sel);
  }

  const f2 = (x) => (x == null ? '—' : x.toFixed(2));
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

  function hud(sel) {
    $('clock').textContent = E.fmtClock(S.clock);
    $('playState').textContent = S.playing ? 'PLAYING' : (S.clock >= S.meta.close_ms ? 'CLOSED' : 'PAUSED');
    $('speed').textContent = $('speed2').textContent = speedLabel();
    $('uPx').textContent = f2(sel.px);
    $('offset').textContent = S.offset === 0 ? '0 (ATM)' : `${S.offset > 0 ? '+' : ''}${S.offset} (${S.offset > 0 ? 'OTM' : 'ITM'})`;
    quoteHud('c', sel.C, sel.kc);
    quoteHud('p', sel.P, sel.kp);
    $('play').innerHTML = S.playing ? '&#x23F8;' : '&#x25B6;';
    if (document.activeElement !== $('timeline')) $('timeline').value = S.clock;
  }

  function showMeta() {
    const m = S.meta;
    $('meta').textContent =
      `${m.root} ${m.session_date} · ${m.dte}DTE → exp ${m.expiry}\n` +
      `ATM at open ${m.atm_strike_at_open} · ${m.strikes.length} strikes (±${m.strike_window})\n` +
      `option cadence ${m.cadence} · underlying: ${m.underlying_source.split(' (')[0]}`;
  }

  // ------------------------------------------------------------------ clock
  let lastFrame = performance.now();
  function frame(now) {
    const dt = now - lastFrame;
    lastFrame = now;
    if (S.data && S.playing) {
      S.clock = E.advanceClock(S.clock, dt, speed(), S.meta.open_ms, S.meta.close_ms);
      if (S.clock >= S.meta.close_ms) S.playing = false;
    }
    render(false);
    requestAnimationFrame(frame);
  }

  function seek(ms) {
    if (!S.data) return;
    S.clock = Math.min(S.meta.close_ms, Math.max(S.meta.open_ms, ms));
    S.rendered.full = true;      // rebuild prefix (also handles backwards seeks)
  }
  function step(dir) {
    if (!S.data) return;
    S.playing = false;
    S.clock = E.stepBoundary(S.clock, E.INTERVALS[S.intervalKey], dir, S.meta.open_ms, S.meta.close_ms);
  }
  function setSpeed(i) { S.speedIdx = Math.max(0, Math.min(E.SPEEDS.length - 1, i)); savePrefs(); render(true); }
  function setOffset(o) {
    const w = S.meta ? S.meta.strike_window : 15;
    S.offset = Math.max(-w, Math.min(w, o)); savePrefs(); render(true);
  }
  function setMode(mode) {
    S.mode = mode;
    $('mode').textContent = mode === 'blind' ? 'BLIND' : 'REVIEW';
    $('mode').className = `mode ${mode}`;
    render(true);
  }
  function togglePlay() {
    if (!S.data) return;
    if (!S.playing && S.clock >= S.meta.close_ms) seek(S.meta.open_ms);
    S.playing = !S.playing;
    render(true);
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
    const inp = $('date');
    if (S.sessions.length) { inp.min = S.sessions[0]; inp.max = S.sessions[S.sessions.length - 1]; }
    snapDate();
  }

  // Snap the date input to an available session (next one at/after, else the last).
  function snapDate() {
    const want = $('date').value, list = S.sessions;
    if (!list.length) { $('note').textContent = 'no sessions for this root/DTE'; return; }
    if (list.includes(want)) { $('note').textContent = ''; return; }
    const next = list.find((d) => d >= want) || list[list.length - 1];
    $('note').textContent = want ? `${want} unavailable → ${next}` : '';
    $('date').value = next;
  }
  function shiftDay(dir) {
    const list = S.sessions, i = list.indexOf($('date').value);
    const j = i < 0 ? list.length - 1 : Math.max(0, Math.min(list.length - 1, i + dir));
    $('date').value = list[j]; $('note').textContent = '';
  }

  async function loadSlice() {
    const root = $('root').value, dte = $('dte').value, date = $('date').value;
    if (!date) return;
    savePrefs();
    S.playing = false;
    overlay(`Slicing ${root} ${date} ${dte}DTE from the archive… (first load of a session takes ~5–10 s; cached after)`);
    try {
      const data = await getJson(`/api/slice?date=${date}&root=${root}&dte=${dte}&cadence=1s`);
      S.data = data; S.meta = data.meta;
      $('timeline').min = S.meta.open_ms; $('timeline').max = S.meta.close_ms;
      prepare();
      S.clock = S.meta.open_ms;
      setMode('blind');
      showMeta();
      overlay(null);
      render(true);
    } catch (e) {
      overlay(`No data: ${e.message}`);
      setTimeout(() => overlay(null), 4000);
    }
  }

  // ------------------------------------------------------------------ input
  const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)
    && document.activeElement.type !== 'range';

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { $('help').classList.add('hidden'); document.activeElement.blur(); return; }
    if (typing() || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const k = ev.key;
    const handled = {
      ' ': togglePlay,
      ArrowRight: () => step(1), ArrowLeft: () => step(-1),
      '[': () => setSpeed(S.speedIdx - 1), ']': () => setSpeed(S.speedIdx + 1),
      Home: () => seek(S.meta && S.meta.open_ms), End: () => seek(S.meta && S.meta.close_ms),
      ',': () => setOffset(S.offset - 1), '.': () => setOffset(S.offset + 1),
      v: () => setMode(S.mode === 'blind' ? 'review' : 'blind'),
      g: () => $('goto').focus(),
      '?': () => $('help').classList.toggle('hidden'),
    }[k];
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
    const ms = E.parseClock(ev.target.value);
    if (ms != null) seek(ms);
    ev.target.value = ''; ev.target.blur();
  });
  $('interval').onchange = (ev) => { S.intervalKey = ev.target.value; savePrefs(); if (S.data) prepare(); ev.target.blur(); };
  $('root').onchange = $('dte').onchange = async (ev) => { ev.target.blur(); await loadSessions(); };
  $('date').onchange = (ev) => { snapDate(); ev.target.blur(); };
  $('prevDay').onclick = () => shiftDay(-1);
  $('nextDay').onclick = () => shiftDay(1);
  $('load').onclick = (ev) => { ev.target.blur(); loadSlice(); };

  // ------------------------------------------------------------------ boot
  // Deep link: ?root=SPXW&dte=0&date=2026-08-28&t=10:32&mode=review&speed=10&play=1 (overrides saved prefs).
  (async function boot() {
    const q = new URLSearchParams(location.search);
    const p = { ...loadPrefs(), ...Object.fromEntries(['root', 'dte', 'date'].filter((k) => q.has(k)).map((k) => [k, q.get(k)])) };
    $('root').value = p.root || 'SPXW';
    $('dte').value = p.dte || '0';
    if (p.interval && E.INTERVALS[p.interval]) { S.intervalKey = p.interval; $('interval').value = p.interval; }
    if (Number.isInteger(p.speedIdx)) S.speedIdx = Math.max(0, Math.min(E.SPEEDS.length - 1, p.speedIdx));
    if (Number.isInteger(p.offset)) S.offset = p.offset;
    $('date').value = p.date || '';
    try {
      await loadSessions();
      if (!p.date && S.sessions.length) $('date').value = S.sessions[S.sessions.length - 1];
      await loadSlice();
      if (S.data && q.has('t')) { const ms = E.parseClock(q.get('t')); if (ms != null) seek(ms); }
      if (S.data && q.get('mode') === 'review') setMode('review');
      if (S.data && q.has('speed')) { const i = E.SPEEDS.indexOf(+q.get('speed')); if (i >= 0) S.speedIdx = i; }
      if (S.data && q.get('play') === '1') S.playing = true;
    } catch (e) {
      overlay(`Server error: ${e.message}`);
    }
    requestAnimationFrame(frame);
  })();
})();
