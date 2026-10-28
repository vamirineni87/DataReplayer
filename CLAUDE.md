# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

DataReplayer is a local, browser-based **historical option replay trainer**: replay one past
trading day from the operator's ThetaData tick archive and practice 0–2 DTE long-option entries
with the live tool's keys (`c` buy call / `p` buy put / `x` close), priced exactly like the live
tool. Training/replay only — not a backtester, not a live trader.

Read **`docs/SPEC.md`** (full spec) and **`T:\data\ThetaData\THETA_ARCHIVE_HANDOFF.md`**
(data provenance) before writing code.

## Status
Git remote: `https://github.com/vamirineni87/DataReplayer` (**public**, MIT). Build in the SPEC §7
phases (each independently runnable):
1. **Slicer CLI** — done (`replayer/slicer.py`).
2. **Smooth chart + clock** — done (`replayer/server.py`, `web/`).
3. **MVP** — mostly done: `c`/`p`/`x` marking, exact re-pricing, P&L + MFE/MAE, journal panel,
   real trades from `order_history.json`, JSON upload overlays, entry→exit connectors. Not yet:
   CSV column mapping, notes/tags editing.
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
open: data horizon (Schwab L1). Journal = standalone `journal/trades.jsonl` for now. Uploads = JSON in
`order_history.json` shape (operator's choice) or a practice export; real trades are read
(read-only) from the companion repo's `order_history.json` (path: `config.ORDER_HISTORY`).

User-facing docs (the repo is meant to be public): `README.md`, `docs/GUIDE.md` (feature tour,
screenshots in `docs/screenshots/`), `docs/DATA.md` (expected archive layout/columns, trade-file +
journal schemas, slice JSON, API), `docs/DESIGN.md` (pricing contract, no-look-ahead rules, data
quirks, architecture). Keep them in sync when behaviour or schemas change. Retake screenshots against a server with `REPLAYER_JOURNAL` pointing at a
scratch file and `ORDER_HISTORY` at a missing file, so no private trades appear in them.

## Commands
- All tests: `python tests/run_all.py`
- Filter: `python tests/run_all.py <module-substr> [<test-substr>]`, e.g.
  `python tests/run_all.py slicer as_of`. Tests build a tiny fake archive in a temp dir
  (`tests/fixtures.py`) and repoint `replayer.config`; tests needing the real `T:` archive raise
  `unittest.SkipTest` when it's absent. New test modules must be added to `MODULES` in `run_all.py`.
  `FakeArchive` also redirects `config.JOURNAL_PATH` / `config.ORDER_HISTORY` to the temp dir —
  tests must never touch the real journal or order history. For manual UI tests that trade, run
  a second server with `REPLAYER_JOURNAL=<scratch path>` so practice marks don't pollute the journal.
- Slice a session: `python -m replayer.slicer 2026-08-28 SPXW 0 [--cadence 1s|trade] [--window 15] [--out f.json] [--no-cache]`
  (summary on stderr; exit 2 = clean "no data"). Restart the server after slicer changes (it
  imports the code once) and bump `SLICER_VERSION`.
- Server + UI: `python -m replayer.server [--port 8765] [--host 0.0.0.0]` → `http://127.0.0.1:8765/`
  (default localhost; `--host 0.0.0.0` = LAN, no auth — the operator runs it this way at
  `http://192.168.4.76:8765/`).
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
- **Long-only, one position at a time, scale-in allowed** (operator's choice, deliberately beyond
  the live `hotkey_trader.py`): the SAME side again while in a position ADDS `qty` of the HELD
  contract at its mid (not the current offset's strike); the opposite side is refused until `x`;
  `x` (refused while flat) closes everything at the bid. Entry = qty-weighted average of the
  fills; P&L = Σ per fill = (exit_bid − avg) × 100 × total qty. Never sell to open, no partial
  closes.
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
     `ref` so the client computes exact trade-level VWAP/σ. `n` = trade COUNT per second (tape
     speed). `sub` = forming-bar snapshots at each `config.SUB_MS` (250 ms) boundary, stamped at
     the boundary's last ms, only where trades changed the bar, final quarter omitted —
     `Engine.liveSub/ohlcvAsOf/priceAsOf` merge the current second's latest snapshot into the
     in-progress bar (never early, never double-counted with the finished 1s bar).
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
   - `replayer/trades.py`: `quote_at` (exact as-of quote from the FULL tick tape, LRU per
     contract — marks are priced in the browser from 1s data, then re-priced here at the exact
     ms), journal append/read/delete (`journal/trades.jsonl`; P&L recomputed server-side),
     `round_trips` (fills → flat-to-flat FIFO round trips over ALL history, so overnight
     carries pair correctly; the broker's OPENING expiration bookkeeping leg is ignored), and
     `parse_upload`. Routes: `/api/quote`, `/api/journal` (GET/POST/DELETE), `/api/broker`,
     `/api/parse-trades`.
   - `history.daily_bars` + `/api/daily`: prior daily bars (stock eod tier, read-only) **strictly
     before** the session — its eod `close` matches the 16:00 close within cents. Feeds the 1D
     source for EMA/BB (`dailySource()` in app.js: prior closes + today's developing close).
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
   `shiftVisibleRangeOnNewBar` is off. Price scale mimics TradingView: AUTO by default (chart
   drag pans time only); scrolling or dragging the price axis UNLOCKS it — then the chart drags
   freely up/down too and playback stops rescaling. 4.2 has no public price-range setter, so the
   unlocked range (`pane.lock`) is served via the main series' `autoscaleInfoProvider` (others
   report null); `visiblePriceRange()`/`pricePerPixel()` invert the scale margins. "A" or a
   double-click on the axis re-locks. While the operator drags, the replay never moves the view;
   on release `checkFollow()` turns follow off if the newest bar is out of view (⟫ = `goLive`).
   Seeks/loads re-centre and resume follow; a fresh load resets to AUTO.
   `initialView(k)` anchors on the clock's bar (no history →
   mid-pane; history → today's open near the left unless the clock bar would be off-screen) and `follow()` (slide only while the newest bar is being watched;
   restore the range after `setData`, which otherwise keeps the right gap and shoves bars off). Panes sync logical
   ranges only when intervals match. Chart times are fake-UTC seconds displayed as ET wall clock.
   The date picker is a custom calendar enabling only `/api/sessions` days (data-driven, so a
   weekend-trading source would show weekends). **No forward interpolation** (SPEC §4B amended).
   **Sliding window:** lightweight-charts 4.2 re-walks every row of a series on each repaint
   after `update()`, so in BLIND each series holds only the newest `WIN_ROWS` rows (`pane.w` =
   rows left out, `off()` = logical index of today's bar 0; trimmed only while following, grown
   when scrolled to the left edge; REVIEW keeps all). Never index logically with
   `hrows.length + k` — use `off() + k`. Unchanged forming bars aren't re-sent.
   Uploaded files persist in localStorage (`replayer.uploads.v1`) and are re-parsed per Load.
   Indicators are **per pane** (`pane.ind`, chips in the pane header); EMA/BB carry a length
   and a SOURCE timeframe (`mtfSource` + `Engine.mtfEMA/mtfBB`): at a display instant the value
   = completed source closes before it + the price as of it (TradingView's developing HTF value),
   warmed up on history when the source is ≥1m. Wheel over the price axis zooms price via the
   main series' `autoscaleInfoProvider` (`pane.vzoom`); overlays never stretch the scale.
   TradingView-style legend + crosshair sync (`mapTime`); splitters persist in `S.layout`.
3. **Mark + score** — `Engine.canOpen(pos, mode, type)/canClose` (long-only, one position, same
   side = add, refused in REVIEW), `avgEntry`, `optionPnl`, `excursion(t, bid, fills, now)` (MFE/MAE;
   each fill counts only from its own as-of row), `tradeMarkers` (one arrow per fill; reveal with
   the clock in BLIND). Position = `{osi, type, strike, offset, fills:[{t, mid, qty, exact}]}`
   (`syncPos` derives qty / entry_mid / entry_t); journal rows of scaled-in trades carry `fills`
   and the server recomputes qty / entry / P&L from them. Seeking before the LAST fill is clamped; REVIEW is refused while in a position. The trades list lives
   INSIDE the single right-hand side panel, under the option quotes / position (operator wants one
   panel, not a separate journal column); tabs:
   Practice / Real (broker) / Uploaded; markers per source colour. `ConnectorPrimitive` draws
   entry→exit dashed lines at the underlying's prices with a P&L tag (`Engine.tradeConnectors`:
   only once the exit is reached in BLIND); an open position draws a live dotted line to now.
   Marker TEXT is drawn by `ConnectorPrimitive._drawLabels` at `TRADE_FONT` (6px; markers are set with
   empty text) because the library sizes marker text from the chart-wide font (would shrink the axes).
   EMA/BB source timeframes include 15m/30m/1h (`TF_MS`) and 1D. "Tape" chip = trades-per-bar
   histogram (own scale above volume); HUD "Tape (10s)" = `Engine.tapeStats` (finished seconds
   only) vs the session average. Practice "Reset" = `DELETE /api/journal?date=&root=`
   (`trades.journal_reset`, scoped to one session; also drops an open position).
   **Watch log** (mock-trade evidence): `<journal stem>_watch.jsonl` (`trades.watch_*`,
   `/api/watch`) records BLIND `span`s grouped into passes (new pass on any back/forward jump,
   REVIEW, load), `jump` (`rule: zone|fixed` for `n` / Ctrl+arrow skips), `review`, `load` and `skip` (`s`) events;
   `n` = first of `Engine.nextZoneExit` (causal scan for the next 1s close beyond ±`S.zone.k`σ, 30 s inside to
   re-arm, optional lead) and `Engine.nextBigCandle` (2 s AFTER a 1s candle with range ≥ `S.zone.big` × the prior
   5-min max 1s range; never a lead, that would leak); refused in a position; client state `W` in app.js
   (`watchTick` per frame; `seek(ms, continuous)` — forward steps are watching). Trades get
   `after_rewind` (`Engine.seenBefore`: a fill inside an EARLIER pass's span) and
   `after_review`. Clicking a Practice row edits its note (`PATCH`); ⏱ seeks. `/api/export` =
   all trades + watch log. Reset keeps the watch log.
   **Random-blind practice** (`r` / 🎲): random session for the root/DTE with `S.blindDate`, which
   hides the date in the date button, meta, Real tab, and chart time labels (`dayLabel` →
   D, D-1, …) until Reveal. Prices still hint at the era.

All trade overlays (broker history from the companion repo's `order_history.json`, uploaded
CSV/JSON, practice marks) normalize to one canonical trade schema (SPEC §4C) so the renderer is
source-agnostic. Overlays may *display* equity/short/multi-leg trades; the sim only *simulates*
long single options.

Config (`replayer/config.py`): env var > `config.local.json` (git-ignored; the operator's copy
points at `T:\data\ThetaData\…` and the companion repo's `order_history.json`) > project-relative
defaults (`data/…`, `./order_history.json`). Keys: `THETA_PARQUET`, `THETA_STOCK`, `SCHWAB_REC`,
`OPTIONS_FIRST`/`OPTIONS_LAST`, `STRIKE_WINDOW`, `REPLAYER_CACHE`, `REPLAYER_JOURNAL`,
`ORDER_HISTORY`; relative paths resolve against the project dir. Never hard-code a machine path
in code — the repo is public.

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
