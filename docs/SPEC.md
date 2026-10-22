# DataReplayer — Historical Option Replay Trainer (SPEC)

*Spec authored 2026-10-22. Target build dir: `E:\Programming\TradingBot\DataReplayer`.*
*Companion repo (reference only, do NOT import): `E:\Programming\TradingBot\Schwab-TradingBotLite`.*

> **Note (public repo):** this is the original build spec, kept as written. Paths such as `T:\data\…`
> are the author's machine; yours come from `config.local.json` (see `docs/DATA.md`). Where the
> build diverged (e.g. no forward interpolation, §4B), `docs/DESIGN.md` describes what shipped.

---

## 0. One-paragraph summary

Build a **local, browser-based replay trainer** that lets a discretionary trader
practice 0–2 DTE options entries on **historical** market data, using the operator's
own ThetaData tick archive. A session replays one trading day: an underlying chart
plays forward bar-by-bar under a play/pause/speed/step clock, and the operator marks
trades with the **same keys as their live tool** (`c` = buy call, `p` = buy put,
`x` = close). Each marked trade is priced **exactly the way the live tool prices**
(entry at the option **mid**, exit at the option **bid**) from the historical option
tick stream, so practice fills equal what the operator would really have gotten. Closed
trades are scored (realized P&L) and written to a journal.

Beyond live marking, it is also a **review** tool: it can **overlay trades the operator
already took** (imported from their broker history) or **trades uploaded from any other
source** (CSV/JSON), drawing entry/exit markers, connectors, and labels on the chart and
stepping through them in sync with a **smooth, variable-speed** replay (pause, 2×/3×/5×/10×/…).

This is a **training/replay** tool. It is **not** a backtester, not a live trader, not
a broker client, and it never places orders anywhere.

---

## 1. Why this is feasible today (the core premise)

The operator trades long options (SPXW/SPY/QQQ/IWM, 0–2 DTE) with a keyboard tool that
prices **entries off the option mark (mid)** and **exits off the option bid**. They own
a **211 GB ThetaData options tick archive** (OPRA trades + NBBO) that contains, per
option trade, the `bid`, `ask`, and `mid_price` — i.e. the exact inputs that pricing
rule needs. Therefore a replayed entry/exit at wall-clock time **T** can be priced with
the identical rule the live tool uses. **No live data subscription is required** —
replay is historical. This faithfulness (reproducing the operator's own pricing logic on
their own data) is the entire reason to build this rather than use ToS OnDemand / Sierra
/ NinjaTrader / TradingView, none of which can.

---

## 2. The data (verified on disk 2026-10-22 — treat as ground truth)

All data lives on the `T:` NAS. **The build never copies, moves, or writes into these
archives — read-only.** Full provenance doc: `T:\data\ThetaData\THETA_ARCHIVE_HANDOFF.md`
(read it first).

### 2a. ThetaData options archive — `T:\data\ThetaData\parquet\`
OPRA-sourced options tick/greeks/bars, zstd parquet, **2020-01-03 → 2026-08-28**
(one-time bulk harvest; this date is the hard horizon for faithful option replay).

**Intraday tiers exist for exactly 4 roots: `SPY`, `QQQ`, `SPXW`, `IWM`.**
(`SPXW` = the tradable weekly-expiry S&P 500 option root. `SPX` is index-settled and has
no intraday tape here.)

Common columns on every option row: `sequence`, `record_ts` (epoch **ms, UTC**),
`symbol` (OSI string, see §2c), `root`, `expiry` (`YYYY-MM-DD`), `strike` (float),
`contract_type` (`C`/`P`).

| Tier | Path pattern | Granularity | DTE window | Extra columns you need |
|---|---|---|---|---|
| `tick` | `parquet\YYYY\MM\{EXPIRY}\tick_{ROOT}_{EXPIRY}.parquet` | per **trade** + NBBO | **0–10** | `bid ask mid_price price size spread` |
| `trade_greeks` | `parquet\YYYY\MM\{EXPIRY}\trade_greeks_{ROOT}_{EXPIRY}.parquet` | per **trade** | **0–10** | `delta gamma theta vega implied_vol underlying_price` |
| `ohlc1m` | `parquet\YYYY\MM\{EXPIRY}\ohlc1m_{ROOT}_{EXPIRY}.parquet` | **1-min** bar | **11–60** | `open high low close volume vwap` |
| `eod` | `parquet\YYYY\MM\eod_{ROOT}_{YYYY-MM}.parquet` | daily | all | `date open high low close bid ask mid_price` |
| `oi` | `parquet\YYYY\MM\oi_{ROOT}_{YYYY-MM}.parquet` | daily | all | `open_interest` |

`{EXPIRY}` in the path is the **expiration date** (`YYYY-MM-DD`), **not** the trade date.

> **⚠ GOTCHA #1 — per-expiry files merge ~11 trading days.** A single
> `tick_{ROOT}_{EXPIRY}.parquet` contains *every* trade in that expiry's 0–10 DTE window
> (≈11 trading days). Verified: the 2026-08-28 greeks file holds rows stamped 2026-08-14.
> **To replay one session you MUST filter `record_ts` to that session's RTH window.**
> Do not assume one file = one day.

Verified sample sizes (0DTE expiry 2026-08-28): `tick_SPXW` = 24 MB / 1.75M rows /
**558 contracts**; `tick_SPY` = 26 MB / 1.58M rows / 334 contracts. That's all strikes ×
~11 days. After slicing to a few ATM contracts for one session it is kilobytes.

### 2b. ThetaData stock archive — `T:\data\ThetaData\stock\`
U.S. consolidated-tape stock/ETF, zstd parquet, **2018 → present**. Roots: **`SPY`, `QQQ`,
`IWM`** (more planned). **No SPX** (an index does not trade).

> **⚠ GOTCHA #2 — different timestamp convention.** Stock timestamps are **naive ET
> wall-clock** (`timestamp[ns]`, no tz). This is NOT the epoch-ms-UTC `record_ts` of the
> options tiers. A session reads directly as `09:30:00.000 – 15:59:59` in ET. Do NOT apply
> any UTC→ET conversion to stock timestamps.

| Tier | Path pattern | Content |
|---|---|---|
| `quote_1s` | `stock\stock_quote_1s\{SYM}\{YYYY}\quote_1s_{SYM}_{YYYY-MM-DD}.parquet` | **1 row/second** NBBO (`timestamp bid ask bid_size ask_size`), 23,401 rows/session |
| `trade_quote` | `stock\stock_trade_quote\{SYM}\{YYYY}\trade_quote_{SYM}_{YYYY-MM-DD}.parquet` | per trade + NBBO (`trade_timestamp price bid ask …`) ~486k rows/day |
| `eod` | `stock\stock_eod\{SYM}\eod_{SYM}_{YYYY}.parquet` | one row/day |

`quote_1s` is the clean, cheap **underlying backbone** for the chart.

### 2c. OSI option symbol format (for parsing/matching the `symbol` column)
`ROOT` left-padded with spaces to 6 chars, then `YYMMDD`, then `C`/`P`, then strike×1000
as 8 digits. Verified examples: `"SPY   260828C00693000"` (SPY $693 call, exp 2026-08-28),
`"SPXW  260828C08400000"` (SPXW $8400 call). Prefer matching on the structured columns
(`root`, `expiry`, `strike`, `contract_type`) rather than string-parsing when possible.

### 2d. Fallback archive — `T:\data\schwab-recordings\parquet\` (optional, Phase 4+)
Covers **after 2026-08-28** and **intraday SPX**. Contains `options_l1_{DATE}_{HH}.parquet`
(hourly option L1 snapshots — coarser than tick), `equity_1min_{DATE}.parquet` (2021→present),
and `options_merged_replay.parquet` (31.6M rows, 1-min option **OHLC**, Polygon `O:` style,
broad universe, **no bid/ask** — not faithful to the mid/bid pricing; use only as a
wide-symbol convenience, never as the source of truth for the 4 core roots).

---

## 3. The pricing contract (reproduce EXACTLY — this is the point of the tool)

The live tool (`hotkey_trader.py` in the companion repo) prices like this. **Replicate it;
do not invent your own.**

- **Entry (buy to open)** a long option: price = the option **mark = `mid_price`** at the
  marking instant. (Live tool prefers streamed MARK, else `(bid+ask)/2`; the tick archive's
  `mid_price` already equals the mid.)
- **Exit (close / sell to close)**: price = the option **`bid`** at the marking instant.
- **"At the marking instant"** = the most recent option trade row for that contract whose
  `record_ts` ≤ the current replay clock (never a future row — see §5).
- **Realized P&L** for a long option round-trip:
  `pnl = (exit_bid − entry_mid) × 100 × qty`. Default `qty = 1`.
- **Tick rounding (optional fidelity, Phase 4):** the live tool rounds limit prices to the
  nearest option tick (0.01 below $3.00, else 0.05) via `round_option_price` in the companion
  repo's `options_bracket_order.py`. For a practice sim this is a second-order effect; apply
  it only if you want exact parity. Document whichever you choose.
- **One position at a time; long only.** `c` and `p` are refused while a position is open;
  `x` is refused while flat. Never "sell to open" (no short options). This mirrors the live
  tool's core invariant.

### Strike selection when the operator presses `c`/`p`
The live tool picks the contract two ways; support at least MANUAL for Phase 1–3:
- **MANUAL (default):** nearest listed strike to the *current underlying* price, shifted by a
  strike `offset` (0 = ATM; +n = n strikes OTM; −n = ITM). Direction depends on call vs put.
- **AUTO by delta (Phase 4):** the strike whose `|delta|` (from `trade_greeks`) is closest to a
  target (default 0.55). This needs the greeks tier joined on `(symbol, record_ts, sequence)`.

Because the ATM strike moves as the underlying moves intraday, the slicer should load a
**window of strikes** around the day's ATM for both calls and puts (default **ATM ± 15
strikes**, matching the live tool's `STRIKE_WINDOW`) so whatever the operator's offset/delta
selects at any clock time is already in memory.

---

## 4. Architecture — three layers

```
            T:\data\ThetaData  (read-only)
                     │
   ┌─────────────────▼──────────────────┐
   │ 1. SLICER  (Python, server-side)    │  pick (date, root, DTE) → resolve expiry →
   │    reads parquet, normalizes clock, │  filter to session RTH → ATM±15 strikes →
   │    emits compact JSON               │  compact per-contract {t, bid, ask, mid} + underlying
   └─────────────────┬──────────────────┘
                     │  localhost HTTP (JSON)
   ┌─────────────────▼──────────────────┐
   │ 2. REPLAY UI  (browser, HTML/JS)    │  lightweight-charts underlying candles +
   │    clock: play/pause/speed/step     │  option bid/ask/mid readout, advances by clock
   └─────────────────┬──────────────────┘
                     │  keypress c/p/x  (+ offset, qty, speed)
   ┌─────────────────▼──────────────────┐
   │ 3. MARK + SCORE  (browser + server) │  price entry@mid / exit@bid at clock time,
   │    realized P&L, journal to disk    │  one position at a time, long only
   └─────────────────────────────────────┘
```

### Layer 1 — Slicer (`slicer.py`)
Input: `session_date` (ET date), `root` (SPY/QQQ/SPXW/IWM), `dte` (0/1/2).
Steps:
1. **Resolve expiry** = the `dte`-th NYSE trading day ≥ `session_date` (holiday-aware). If no
   `tick_{root}_{expiry}.parquet` exists for that expiry, return a clear "no data" error.
2. **Open** `tick_{root}_{expiry}.parquet`. Use a **column projection** (only the columns in
   §3) and, if practical, a **row-group / predicate pushdown** to limit I/O. The companion
   repo already does symbol-predicate pushdown — see `scripts/pull_history.py:386-572` for a
   working pandas `read_parquet(path, filters=…, columns=…)` pattern to copy the approach.
3. **Normalize the clock to ET:** convert option `record_ts` (epoch-ms UTC) → ET
   (`America/New_York`, DST-aware via `zoneinfo`). Stock `timestamp` is already naive ET —
   leave it. Produce a single monotonic ET timeline (recommend: integer **ms since ET
   session midnight**, or an ET-naive datetime) used by both streams.
4. **Filter to the session:** keep only rows whose ET date == `session_date` and time ∈ RTH
   (09:30:00–16:00:00 ET; SPXW index options run to 16:15 ET — allow a configurable close).
5. **Pick the strike window:** determine the day's ATM from the underlying at/near 09:30,
   keep strikes **ATM ± 15** for both C and P.
6. **Order/dedup** within each contract by `(record_ts, sequence)` — ms stamps collide (up to
   ~50 events share one ms); `sequence` is the required tiebreaker. **Never dedup on
   `record_ts` alone.**
7. **Underlying series:** for SPY/QQQ/IWM read `quote_1s_{root}_{session_date}.parquet` (the
   1s backbone). For **SPXW** there is no stock tape — use `trade_greeks.underlying_price`
   (carried per option trade) resampled to ~1s, or Schwab-recordings intraday SPX.
8. **Emit** a compact JSON the browser streams: `{ underlying: [{t, o,h,l,c} or {t, mid}],
   contracts: { "<osi>": {strike, type, delta?, ticks:[{t, bid, ask, mid}]} }, meta:{…} }`.
   Keep it small: downsample the option readout to the replay cadence (on-trade or 1s grid).

> Keep the slicer dependency-light: `pandas` + `pyarrow` (both already present in the
> operator's Python). A trading-calendar helper is needed for step 1 — copy the companion
> repo's `market_calendar.py` (NYSE holiday-aware) or use `pandas_market_calendars`.

### Layer 2 — Replay UI (`index.html` + `app.js`)
- **Charting:** TradingView **lightweight-charts** (free, MIT — *the* open-source library,
  NOT the application-gated "Charting Library"). Load a **pinned** version from a CDN
  (e.g. `lightweight-charts@4.2.0`). Render the underlying as candles (bucket the 1s/1m into
  the chart interval) plus an option readout (text or a line series of the ATM contract's
  mid).
- **Replay clock:** play / pause / **speed** (e.g. 1×/2×/5×/30×/max) / **step one bar** /
  scrub. Advance a cursor over the ET timeline; on each tick push new bars with
  `series.update(bar)` and keep the newest in view. The clock is the single source of truth
  all data is read "as of."
- **HUD:** current ET time, underlying, the currently-selected ATM contract and its
  bid/ask/mid, open-position state + live unrealized P&L (marked to current bid), and a
  session-trades list with realized P&L and a running total (mirror the live tool's
  POSITION + SESSION TRADES panels).

### Layer 3 — Mark + score
- **Keys:** `c` buy call / `p` buy put / `x` close — refused when the state forbids it
  (long-only, one-at-a-time). Also `,`/`.` strike offset −/+, `;`/`'` qty −/+, space = play/
  pause, `→` step, `[`/`]` speed. Keep the key map close to the live tool so it trains real
  muscle memory.
- On `c`/`p`: resolve the contract (§3 strike selection) from the loaded window, record entry
  at that contract's **mid** as of the clock, set state to in-position.
- On `x`: record exit at the held contract's **bid** as of the clock, compute realized P&L,
  append to the journal, return to flat.
- **Journal:** append each closed round-trip to a local file `journal/trades.jsonl`
  (one JSON object/line: session_date, root, contract, side, entry_t, entry_mid, exit_t,
  exit_bid, qty, pnl). This is the training record; later it can feed the operator's existing
  P&L calendar.

---

## 4A. Full feature set (from the operator's perspective)

This is the "think about everything I'd need as a user" section. Features are grouped and
tagged with a target phase (see §7). **MVP = the ★ items.**

### 4A.1 Playback & the replay clock  ★
The replay must feel like a smooth tape you scrub through, not a slideshow.
- **Transport:** Play / Pause (spacebar) ★, Stop/Reset to session open ★, Step forward one
  bar (`→`) ★ and step back one bar (`←`).
- **Variable speed:** a speed control with discrete stops **1× 2× 3× 5× 10× 30× 60× Max**
  ★, plus a **slow-mo 0.25×/0.5×** for drilling a fast move. `[` / `]` cycle speed down/up.
  "Max" renders as fast as the browser can without dropping the no-look-ahead guarantee.
- **Smoothness (see §4B for the engine):** playback is decoupled from data cadence — the clock
  advances on a fixed render timer (`requestAnimationFrame`), and the underlying line is
  **interpolated between samples** so motion is fluid even at 1× on sparse data and legible at
  10×+. No visible stutter on dense 0DTE ticks.
- **Seek / scrub:** a **timeline slider** across the whole session; drag to jump anywhere ★.
  Type a time (`10:32`) to jump. Click a trade marker or event to jump to it.
- **Jump shortcuts:** to session **Open** / **Close**, to **next/prev trade marker**, to
  **next/prev of my own marks**.
- **Loop a segment:** set an A–B range on the timeline and loop it (drill one setup
  repeatedly). (Phase 4)
- **Clock readout:** large **ET time** + current speed + play state, always visible ★.

### 4A.2 Chart & context
- **Underlying** candles + volume, with an **interval selector** (1s / 5s / 15s / 1m) that
  buckets the source data ★ (1m default for smoothness; 1s for fine work).
- **Option pane** (second panel): the selected ATM contract's **bid/ask/mid** as a line (or
  candles), tracking the clock ★.
- **Reference levels** common to 0DTE: **VWAP**, a couple of **MAs**, **prior-day H/L**,
  **opening-range H/L**, **premarket H/L**. (VWAP + prior-day levels in Phase 3; rest Phase 4.)
- **Crosshair** with price/time readout ★; a **measure tool** (price/%/time between two
  points); light **drawing tools** (horizontal line, trendline, rectangle/zone) with
  persistence per session. (Drawings Phase 4.)
- **Session shading:** RTH open/close lines; optional lunch/【key-time】bands.
- **Symbol / DTE / date selectors** (see 4A.5).

### 4A.3 Trade overlays & import  ★ (the operator's explicit ask)
Show trades **on the chart** with entry/exit markers and identifiers, from three sources:
1. **My real trades** — auto-loaded from the broker history for the replayed day (the
   companion repo's `order_history.json`; see §4C for the mapping). ★
2. **Uploaded trades** — drag-drop a **CSV or JSON** from any source (TradingView export, a
   spreadsheet, another tool). A **column-mapping UI** maps the file's columns to the canonical
   trade schema (§4C). ★
3. **My practice trades** — the marks made in this tool during replay (§4A.4), shown the same
   way so you can compare.

Overlay rendering:
- **Entry marker** (up/down arrow or ▲/▼) at entry time/price; **exit marker** at exit; a
  **connector** (dashed line or shaded region) spanning the hold ★; **P&L label** (and R
  multiple / hold time if present) on the exit ★.
- **Identifiers:** color by **source**, by **win/loss**, or by a **tag/strategy** column;
  show a text label (ticker, side, tag) ★.
- **Layers:** each source/set is a toggleable layer (show/hide, per-layer color) ★. Load
  **multiple sets at once** (e.g. my real trades + a mentor's uploaded trades).
- **Reveal-in-sync vs show-all:** either reveal each marker as the clock reaches its timestamp
  (feels live) or show the whole day's trades at once (pure review) — a toggle ★.
- **Click a marker →** detail popover: entry/exit times & prices, qty, P&L, MFE/MAE if known,
  notes ★. **Filter** overlays by symbol / side / tag / outcome.
- **Compare mode:** align my practice trade with the real trade I took at that moment — did I
  enter earlier/better, exit too soon? Show a small side-by-side verdict. (Phase 4)

### 4A.4 Trading simulation (marking)  ★
- **Long options, one position at a time** (mirrors the live tool): `c` buy call ★, `p` buy
  put ★, `x` close ★. Illegal keys are refused (can't open while in a position, can't close
  while flat).
- **Adjusters:** strike offset `,`/`.` ★, quantity `;`/`'` ★, MANUAL↔AUTO-delta toggle
  (Phase 4), DTE/symbol selectors.
- **Pricing:** entry @ option **mid**, exit @ option **bid**, as of the clock (§3) ★.
- **Bracket simulation (Phase 4, high fidelity):** optionally arm a trailing-stop % + take-
  profit % on entry (as the live tool does) and let the replay **auto-close** when the option
  bid/ask crosses them — this trains the operator's *actual* bracket workflow, not just manual
  exits.
- **Position panel:** live unrealized P&L marked to current bid ★, plus **MFE/MAE** during the
  hold (max favorable/adverse excursion — a metric the operator already tracks).
- **Edit/undo:** undo the last mark; edit or delete a marked trade before it's journaled ★.

### 4A.5 Session selection & navigation
- **Date picker** restricted to **available** sessions, with a hint of which roots have data
  for a date ★. **Symbol** (SPY/QQQ/SPXW/IWM) ★ and **DTE** (0/1/2) ★ selectors.
- **Random session** mode for unbiased practice: jump to a random available day, optionally
  **blind** (hide the date/price axis labels) so you can't recognize the day. (Phase 4)
- **Queue/watchlist** of sessions to drill in order. (Phase 4)

### 4A.6 Scoring, journaling & analytics
- **Per-session summary:** # trades, win %, net P&L, avg R, avg hold, total MFE/MAE ★.
- **Journal:** every closed practice trade appended to `journal/trades.jsonl` with optional
  **notes** and **tags** (setup, mistake) ★. Edit notes after the fact.
- **Aggregate dashboard** across practice sessions (win% by setup, P&L curve); can later feed
  the operator's existing P&L **calendar** in the companion repo. (Phase 4)
- **Export** practice trades to CSV/JSON — which can be **re-imported as an overlay** later
  (closing the loop with §4A.3). ★

### 4A.7 UX & quality-of-life
- **Keyboard-first**, with an on-screen **help/cheatsheet overlay** (`?`) listing every key ★.
- **Dark theme** (match the operator's calendar) ★.
- **Persist** last-used symbol/speed/interval/layer toggles in `localStorage` ★.
- Clear, non-blocking **"no data for this selection"** messaging (§5 rule 7) ★.
- **Reveal/blind toggle** for honest practice (§4A.1, §5 rule 8).

## 4B. Smooth-playback engine (how to make it not stutter)

0DTE option tapes are dense and bursty; a naïve "advance index on a timer" loop will stutter.
Build the clock like this:
- **Single master clock** in ET session-ms. Advance it on a fixed render tick
  (`requestAnimationFrame`, ~60 fps): `clock += (realDeltaMs × speed)`. Rendering rate is
  constant; **speed only changes how much session-time elapses per frame**. This keeps motion
  smooth at every speed.
- **Decouple data from frames.** Pre-sort each series by time in the slicer. Each frame, binary-
  search the cursor to the last sample ≤ clock and draw up to there — O(log n), never a per-tick
  loop. For the underlying **line**, **interpolate** between the straddling samples so the dot/
  line glides rather than jumps.
  > **Build decision (2026-10-22): no forward interpolation.** Interpolating toward the *next*
  > sample reads a future price and leaks the next tick's direction, violating §5 rules 1 and 8.
  > The build keeps motion smooth with the fixed-rate clock + the in-progress (partial) candle
  > built only from samples ≤ clock, and never interpolates forward.
- **Pre-bucket candles** at the chosen interval in the slicer so the chart appends a finished
  bar with `series.update()` only when the clock crosses a bar boundary (cheap), while a
  separate smooth marker shows the within-bar price.
- **Keep the browser payload small** (§4 slicer): ship only ATM±15 contracts for one session,
  downsample the option readout to ≤ the render cadence; keep tick-accurate prices only for the
  exact instant a mark is made. Target < a few MB per session.
- **Buffer/prefetch** the next time-segment if a session is streamed in chunks; never block the
  render thread on I/O.
- Dropped frames at "Max" are fine **as long as the clock math stays monotonic and no
  future data is shown** — smoothness must never come at the cost of look-ahead (§5).

## 4C. Canonical trade schema & import mapping

All overlays (my real trades, uploads, my practice trades) normalize to one schema so the
renderer is source-agnostic:

```json
{
  "id": "stable-unique-id",
  "source": "broker" | "upload:<filename>" | "practice",
  "symbol": "SPXW" | "SPY260828C07700000" | "...",   // underlying OR OSI option
  "side": "long_call" | "long_put" | "buy" | "sell" | "short" | "...",
  "qty": 1,
  "entry_ts": "2026-08-28T10:14:03-04:00",   // ISO8601 with tz, OR naive ET (state which)
  "entry_price": 7.85,
  "exit_ts": "2026-08-28T10:19:40-04:00",    // null if still open / entry-only marker
  "exit_price": 9.10,
  "pnl": 125.0,            // optional; computed if absent and prices present
  "tag": "ORB",           // optional strategy/setup label
  "note": "...",          // optional free text
  "r_multiple": 1.8,      // optional
  "mfe": 180.0, "mae": -40.0   // optional excursion $, shown if present
}
```

- **Minimum required for a usable overlay:** `symbol`, `entry_ts`, `entry_price` (an
  entry-only marker is valid). `exit_*` draws the exit + connector; `pnl`/`tag`/`note` enrich
  the label and popover.
- **Timezone on import:** ask whether timestamps are ET or UTC (or detect tz-aware ISO). Place
  markers on the replay's ET timeline (align to the session's own clock — §2 Gotcha #2).
- **Import formats:** CSV and JSON. For CSV, present a **column-mapping UI** (file column →
  schema field) with sensible auto-guesses; remember the mapping per filename. Validate and
  report rows that can't be mapped (don't silently drop).
- **My real trades (`source:"broker"`):** read the companion repo's `order_history.json`
  (`fills` array: symbol, qty, price, time, net_cash, fee…), pair opens↔closes into round-trips
  for the replayed day, map to the schema. Treat the file as **read-only private data** (do not
  modify it; keep it out of git here).
- **Matching to the replayed session:** filter overlays to the session date; an option overlay
  whose contract is in the loaded ATM±15 window can also anchor to the option pane, otherwise it
  anchors to the underlying pane by time only.

## 5. Correctness rules the build MUST honor

1. **No look-ahead.** A price "as of clock T" is the latest row with `record_ts/timestamp ≤ T`.
   Never read a future row. This is the cardinal sin of a replay trainer — enforce it in the
   slicer's emitted structure (pre-sort) and in the UI cursor.
2. **Clock unification.** Options are UTC-ms; stock is naive ET. Convert options → ET once in
   the slicer; never mix conventions downstream. Add a unit test that asserts an SPXW 0DTE
   session's first/last option `record_ts` map to ~09:30/~16:00 ET.
3. **`(record_ts, sequence)` ordering**, never `record_ts` alone (ms collisions).
4. **Session date-filter** on per-expiry option files (Gotcha #1).
5. **Long-only, one-position** state machine (matches the live tool; refuse illegal keys).
6. **Read-only** on all `T:\…` archives. Write only under the project dir (`journal/`, caches).
7. **Graceful "no data"** for: a (root, DTE) with no expiry file; a session date > 2026-08-28
   for options (tell the user the horizon); a root with no stock tape (SPXW underlying).
8. **Blind reveal (chart integrity).** In blind/live mode the chart must **not render bars or
   trade markers beyond the clock** — reveal them only as the clock reaches their time. A
   "review / show-all" toggle may reveal the whole session (and all overlays) at once, but that
   mode must be explicit and never active while the operator is marking live practice trades.
   Smoothness optimizations (§4B) must never leak future data to achieve fluidity.

---

## 6. Tech stack & conventions

- **Python 3** backend: `pandas`, `pyarrow` (verified present), stdlib `http.server` for the
  local server (model it on the companion repo's `scripts/serve_calendar.py` — re-reads data
  per request so edits show live). No framework required; FastAPI is acceptable if preferred.
- **Frontend:** one static HTML page + vanilla JS + lightweight-charts from a pinned CDN. No
  build step.
- **Config:** a small `config` (env or JSON) for archive roots (`THETA_PARQUET=T:\data\ThetaData\parquet`,
  `THETA_STOCK=T:\data\ThetaData\stock`, `SCHWAB_REC=T:\data\schwab-recordings\parquet`),
  `STRIKE_WINDOW=15`, default speed, RTH close per asset class.
- **Tests:** offline unit tests (no network, no live data) in `tests/`, runnable like the
  companion repo's `python tests/run_all.py`. Cover: expiry resolution, UTC→ET conversion,
  session date-filter, `(record_ts,sequence)` ordering, no-look-ahead price-as-of, strike
  selection, and P&L math. Use tiny synthetic parquet fixtures (do NOT depend on the 211 GB
  archive being present in CI).
- **Platform:** Windows 11 (the `T:` drive is a Windows NAS mount). Paths are Windows paths.

---

## 7. Phasing (ship in slices; each phase is independently useful)

- **Phase 1 — Slicer proves out.** CLI: given `2026-08-28 SPXW 0`, emit the compact JSON for
  ATM±15 (option bid/ask/mid + underlying) to stdout/file. Verifies expiry resolution, UTC→ET,
  session filter, `(record_ts,sequence)` order, pushdown. No UI.
- **Phase 2 — Smooth chart + clock.** Serve `index.html`; lightweight-charts underlying candles
  (interval selector) + option pane; the **smooth variable-speed engine** of §4B (play/pause,
  1×–60×+slow-mo, step, timeline scrub), blind reveal (§5 rule 8), ET clock HUD, crosshair.
  No trading yet.
- **Phase 3 — Mark + score + overlays. (MVP)** `c`/`p`/`x` long-only state machine,
  entry@mid/exit@bid, live unrealized P&L + MFE/MAE, session-trades list, journal to
  `journal/trades.jsonl`; **trade overlays** (§4A.3) for my real trades (`order_history.json`)
  and **CSV/JSON upload** with column-mapping (§4C), entry/exit markers + connectors + P&L
  labels, layer toggles, reveal-in-sync; help overlay (`?`); dark theme; `localStorage` persist;
  export practice trades.
- **Phase 4 — Fidelity & power features (optional):** AUTO-delta strike pick from greeks; tick
  rounding for exact price parity; **bracket simulation** (trailing-stop/TP auto-close, §4A.4);
  compare my practice vs my real trade (§4A.3); reference levels (VWAP/prior-day/ORB) + drawing
  tools + measure; A–B loop + random/blind session mode + session queue; aggregate analytics
  dashboard feeding the companion calendar; post-2026-08-28 + intraday SPX via Schwab-recordings
  L1.

**Acceptance (MVP = end of Phase 3):** load SPXW 2026-08-28 0DTE; the underlying replays
**smoothly at 1× and 10×** with pause/scrub and **no future bars shown**; an **uploaded CSV of
trades renders entry/exit markers** with P&L labels on the correct times; press `c`, watch
unrealized P&L move with the bid, press `x`, and get realized P&L = `(exit_bid − entry_mid) ×
100` for the auto-selected ATM contract — all read-only off `T:` and with no look-ahead.

---

## 8. Non-goals (do not build these)

- No live data, no streaming, no broker/OAuth, no order placement anywhere.
- Not a strategy backtester or optimizer (no signals, no auto-entries, no parameter sweeps).
- No multi-leg/spreads, no short options, no equity-share mode **in the simulation** (the
  marking engine is long single options only, to match how the operator trains). Note: trade
  **overlays/imports are source-agnostic and may _display_** equity, short, or multi-leg trades
  for review (§4C allows any `side`) — display ≠ simulate. Simulating those is future work.
- Do not modify, re-harvest, or re-download the `T:` archives. Do not import code from the
  companion repo at runtime — *reference* its patterns and copy small helpers (e.g.
  `market_calendar.py`) into this project so DataReplayer stands alone.
- No cloud, no database, no auth, no accounts.

---

## 9. Reference pointers in the companion repo (read, don't import)

`E:\Programming\TradingBot\Schwab-TradingBotLite\`:
- `scripts/pull_history.py` lines ~386–572 — a working parquet loader that opens the same
  ThetaData tick files, routes to Schwab-recordings after `THETA_LAST='2026-08-28'`, reads
  `record_ts`/`symbol`/`mid_price` with symbol pushdown. **Best model for the slicer's I/O.**
- `scripts/serve_calendar.py` — minimal local HTTP server pattern (re-reads per request).
- `hotkey_trader.py` — the live tool whose pricing (`fresh_option_price`: entry→mark/mid,
  exit→bid), one-position/long-only state machine, SESSION TRADES P&L, and key map this
  trainer mirrors. `options_bracket_order.py` has `round_option_price` (tick rounding).
- `market_calendar.py` — NYSE trading-day/holiday helper (copy it for expiry resolution).
- `T:\data\ThetaData\THETA_ARCHIVE_HANDOFF.md` — authoritative data provenance; **read first.**

---

## 10. Open decisions for the operator (ask before/while building)

1. **First instrument:** SPXW 0DTE (their primary) or SPY 0DTE first?
2. **Chart panels:** show the UNDERLYING only, the OPTION mid only, or both?
3. **Replay cadence:** advance on every option trade (finest, heavier) or on a fixed 1s grid
   (smoother, lighter)?
4. **Data horizon:** is the 2020 → 2026-08-28 options archive enough, or should Phase 4
   include Schwab-recordings L1 for post-Aug-2026 days (and intraday SPX)?
5. **Journal destination:** standalone `trades.jsonl`, or also feed the operator's existing
   P&L calendar in the companion repo?
6. **Overlay sources at launch:** which upload formats matter first (a TradingView export? a
   specific broker CSV? a hand-kept spreadsheet)? Share one real sample file so the column
   mapping (§4C) targets it exactly.
7. **Reveal default:** should a session open in **blind** mode (future hidden, for honest
   practice) or **review/show-all** (for studying trades you already took)?
