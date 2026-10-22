# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DataReplayer is a local, browser-based **historical option replay trainer**: replay one past
trading day from the operator's ThetaData tick archive and practice 0–2 DTE long-option entries
with the live tool's keys (`c` buy call / `p` buy put / `x` close), priced exactly like the live
tool. Training/replay only — not a backtester, not a live trader.

Read **`docs/SPEC.md`** (full spec) and **`T:\data\ThetaData\THETA_ARCHIVE_HANDOFF.md`**
(data provenance) before writing code.

## Status
Git remote: `https://github.com/vamirineni87/DataReplayer` (private). Build in the SPEC §7
phases (each independently runnable):
1. **Slicer CLI** — done (`replayer/slicer.py`).
2. **Smooth chart + clock** — done (`replayer/server.py`, `web/`).
3. **MVP** — `c`/`p`/`x` marking, P&L, journal, trade overlays + CSV/JSON import.
4. Optional fidelity/power features (AUTO-delta, tick rounding, brackets, Schwab-recordings).

Confirm the SPEC §10 open decisions with the operator before/while building (first instrument,
chart panels, replay cadence, data horizon, journal destination, upload formats, blind vs
review default).
Decided so far: SPXW 0DTE is the default/first-tuned root; 1s option cadence; both reveal modes,
**always opening BLIND**. The operator trades SPXW but **charts SPY as the SPX proxy** and wants a
TradingView-like layout (SPY 1m on top, SPY 1s below, each with session VWAP ±1.8/2/2.2/2.5/3σ,
volume, developing POC/VAH/VAL + volume profile; optional EMA20 + Bollinger; 5–10 prior days of
context on the 1m chart) — but **every view stays selectable** (presets + per-pane
source/interval; never remove a view). Date picking shows only days with data. Still
open: data horizon (Schwab L1), journal destination, upload formats (ask for a sample file).

## Commands
- All tests: `python tests/run_all.py`
- Filter: `python tests/run_all.py <module-substr> [<test-substr>]`, e.g.
  `python tests/run_all.py slicer as_of`. Tests build a tiny fake archive in a temp dir
  (`tests/fixtures.py`) and repoint `replayer.config`; tests needing the real `T:` archive raise
  `unittest.SkipTest` when it's absent. New test modules must be added to `MODULES` in `run_all.py`.
- Slice a session: `python -m replayer.slicer 2026-08-28 SPXW 0 [--cadence 1s|trade] [--window 15] [--out f.json] [--no-cache]`
  (summary on stderr; exit 2 = clean "no data"). Restart the server after slicer changes (it
  imports the code once) and bump `SLICER_VERSION`.
- Server + UI: `python -m replayer.server [--port 8765]` → `http://127.0.0.1:8765/`.
  Deep link `/?root=SPXW&dte=0&date=2026-08-28&t=10:32&mode=review&view=classic&speed=60&play=1`.
- JS engine tests alone: `node tests/test_engine.js` (run_all bridges them via `test_engine_js`).
- Visual check without a browser session: headless Chrome
  `chrome --headless=new --window-size=1600,900 --virtual-time-budget=15000 --screenshot=<out.png> "<deep link>"`
  (canvas can lag the DOM by a frame while playing).

## Hard rules
- **Archives are READ-ONLY.** Never write, move, delete, re-download, or re-harvest anything
  under `T:\data\…`. Write only inside this project dir (`journal/`, `cache/`, etc.).
- **No orders, no broker, no live data, ever.** This tool only reads historical files and
  simulates. No OAuth, no network trading, no streaming.
- **No look-ahead.** A price "as of clock T" is the last row with timestamp ≤ T. The chart
  must hide bars and trade markers beyond the clock in blind mode; "review/show-all" must be an
  explicit toggle and never active while marking practice trades. Smoothness optimizations must
  never leak future data. This is the integrity core of a trainer — a bug here invalidates all
  practice. Unit-test it.
- **Two timestamp conventions** (SPEC §2): options `record_ts` = epoch-ms **UTC**; stock
  `timestamp` = naive **ET**. Convert options→ET once in the slicer; never mix downstream.
- **Order by `(record_ts, sequence)`**, never `record_ts` alone (ms collisions). `sequence` is a
  32-bit counter stored signed — it **wraps negative mid-session** (verified on real data), so
  compare it unsigned: `slicer.seq_key()` (`seq & 0xFFFFFFFF`).
- **Date-filter per-expiry option files** — one file merges ~11 trading days (SPEC Gotcha #1).
- **Stand alone.** Reference the companion repo (`E:\Programming\TradingBot\Schwab-TradingBotLite`)
  for patterns and copy small helpers (e.g. `market_calendar.py`), but do NOT import it at
  runtime or create a cross-project dependency.

## Pricing contract (SPEC §3 — reproduce exactly, don't invent)
- Entry = option `mid_price` as of the clock; exit = option `bid` as of the clock.
- `pnl = (exit_bid − entry_mid) × 100 × qty` (default qty 1).
- **Long-only, one position at a time:** `c`/`p` refused while in a position, `x` refused while
  flat. Never sell to open. Mirrors `hotkey_trader.py` in the companion repo.
- MANUAL strike pick = nearest strike to the current underlying, shifted by `offset`
  (+n = OTM). AUTO-by-delta (target |Δ| 0.55 from `trade_greeks`) is Phase 4.

## Architecture (SPEC §4)
Three layers, data flowing one way:
1. **Slicer (`replayer/slicer.py`)** — `(session_date, root, dte)` → resolve expiry as the
   `dte`-th NYSE trading day ≥ session date (`replayer/market_calendar.py`, copied from the
   companion repo) → read `parquet\YYYY\MM\{EXPIRY}\tick_{ROOT}_{EXPIRY}.parquet` with column
   projection + `record_ts` pushdown → UTC→ET → filter to the NYSE equity session (early closes
   respected) → keep **ATM ± 15 strikes** (C and P) → emit columnar JSON
   `{meta, underlying:{t,p}, contracts:{osi:{strike,type,t,bid,ask,mid}}}`.
   - **Time axis everywhere downstream:** `t` = integer ms since ET midnight of the session date.
   - The archive holds **no option rows after 16:00 ET** for any root (SPXW's 16:15 tail wasn't
     harvested); SPXW has 09:25 pre-open prints that the RTH filter drops.
   - `underlying` (drives strike selection): SPY/QQQ/IWM = `stock_quote_1s` NBBO mid. **SPXW has no
     stock tape** → `trade_greeks.underlying_price` (real SPX). As-of sampled onto a 1s grid.
   - `chart` (what's charted): 1s OHLCV of `config.CHART_SYMBOL[root]` (SPXW → **SPY**) from the
     per-trade `stock_trade_quote` tape; bars stamped at **second end** (`sec*1000+999`) so they're
     visible only once the second is over. OHLC uses `LAST_SALE_CONDITIONS` (0 regular, 95 ISO) —
     codes 96/4/124/2/… print up to $5 off the NBBO and painted false wicks; VWAP/profile use
     `VWAP_CONDITIONS` (+115 odd lots); `v` counts all trades. Ships `vv/pv/p2v` sums centred on
     `ref` so the client computes exact trade-level VWAP/σ.
   - Strike ladder = strikes **first seen at or before the open** (so later listings can't leak
     the day's range); ATM taken from the first underlying sample.
   - Size control, both no-look-ahead-safe: `--cadence 1s` keeps the last row per second with its
     real `t` (stale, never early); then rows whose bid/ask/mid equal the previous row are dropped
     (lossless for as-of). SPXW 0DTE ≈ 7 MB, SPY 0DTE ≈ 3.6 MB uncompressed.
   - Slices are cached as JSON in `cache/` keyed by args + `SLICER_VERSION` — **bump
     `SLICER_VERSION` whenever output changes.** Building one takes ~3–8 s cold.
   - Clean `NoData` errors: past 2026-08-28 horizon, non-trading day, missing expiry file.
   - `replayer/history.py`: N prior sessions (`/api/history`, ≤ `HISTORY_MAX_DAYS`) as 1m bars with
     each day's own VWAP/σ, developing POC/VAH/VAL and final profile, built from the same
     `chart_bars` (same condition filter) and the same profile rule as `engine.profileSeries`;
     one cache file per (symbol, day). Prior days are wholly in the past → always shown.
   - `slicer.prune_cache()` (run at server start) deletes cache files from older
     `SLICER_VERSION`/`HISTORY_VERSION`; bump the matching version whenever output changes.
   - `replayer/server.py`: `/api/sessions?root=&dte=` (dates from `replayer/sessions.py`, which
     scans expiry dir names once → `cache/expiries.json`) and `/api/slice?date=&root=&dte=&cadence=`
     (gzipped, small in-memory LRU; `NoData` → 404 JSON `{error}`). Static files only from `web/`.
2. **Replay UI (`web/`: `index.html`, `app.js`, `engine.js`; lightweight-charts 4.2.0 pinned on
   unpkg; no build step)** — **all look-ahead-sensitive logic lives in `web/engine.js`** (pure, UMD,
   Node-tested): as-of binary search, bucket grid aligned to the open, partial bars from samples
   ≤ clock, per-bucket closes, `pickStrike`, trade-level `vwapSeries`, developing `profileSeries`
   (POC/VAH/VAL per second, 70% VA) and `profileAsOf` (histogram). `app.js`: two `Pane`s, each a
   SOURCE (`chart` | `underlying` | `options` | `none`) at its own interval; View presets
   (`tv`, `classic`, `chartopt`) just configure both panes. A pane is a list of layers
   `{series, full(j), partial(k)}` rendered generically: incremental `series.update()` going
   forward, full `setData` on any backwards move/seek/mode/selection change; a pane's chart is
   destroyed and recreated on Load/config change (fresh axes). One master clock on
   `requestAnimationFrame` (dt clamped to 250 ms). Volume profile = a series primitive
   (`ProfilePrimitive`: prior days drawn inside their own span, today's anchored at its open or
   the left edge). σ-bands, VA and BB lines are excluded from autoscale. Colors follow the
   operator's TradingView: **blue VWAP, orange 2σ**, gray other bands. Chart panes at ≥1m prepend
   history rows (one whitespace separator per day breaks the lines); EMA20/BB(20,2) run over
   history+today closes, in-progress bar stepped from the last closed state. View: the library's
   `shiftVisibleRangeOnNewBar` is off; `initialView()` (no history → first bar mid-pane; history →
   today's open near the left) and `follow()` (slide only while the newest bar is being watched;
   restore the range after `setData`, which otherwise keeps the right gap and shoves bars off). Panes sync logical
   ranges only when intervals match. Chart times are fake-UTC seconds displayed as ET wall clock.
   The date picker is a custom calendar enabling only `/api/sessions` days (data-driven, so a
   weekend-trading source would show weekends). **No forward interpolation** (SPEC §4B amended).
3. **Mark + score** — key handling, pricing as above, journal each closed round-trip to
   `journal/trades.jsonl`.

All trade overlays (broker history from the companion repo's `order_history.json`, uploaded
CSV/JSON, practice marks) normalize to one canonical trade schema (SPEC §4C) so the renderer is
source-agnostic. Overlays may *display* equity/short/multi-leg trades; the sim only *simulates*
long single options.

Config (env or JSON): `THETA_PARQUET=T:\data\ThetaData\parquet`,
`THETA_STOCK=T:\data\ThetaData\stock`, `SCHWAB_REC=T:\data\schwab-recordings\parquet`,
`STRIKE_WINDOW=15`, default speed, RTH close per asset class.

## Privacy
- `order_history.json`, journals, and any uploaded trade files are **private financial data**.
  Git-ignore them (`journal/`, `*.jsonl`, `uploads/`, `order_history.json`, `cache/`). Never
  commit them. Never print account numbers or secrets.

## Engineering conventions
- Python 3 + `pandas` + `pyarrow` (present). FastAPI acceptable but not required.
- **Offline tests** in `tests/`; use tiny synthetic parquet fixtures — do NOT require the 211 GB
  archive to run tests/CI. Cover: expiry resolution, UTC→ET (SPXW 0DTE first/last option row
  ≈ 09:30/16:00 ET), session date-filter, `(record_ts, sequence)` order, no-look-ahead
  price-as-of, strike selection, P&L math.
- Windows 11; `T:` is a Windows NAS path. Prefer absolute archive paths from config.
