# Data reference

DataReplayer ships **no market data**. It reads a local, read-only archive of historical
options and stock data in the ThetaData-derived parquet layout described below. You need your own
data, from a ThetaData subscription or anything you convert into this layout. This page
lists every file and column the code reads, the conventions it relies on, and the files it
writes.

- [Configuration](#configuration)
- [Options archive](#options-archive-theta_parquet)
- [Stock archive](#stock-archive-theta_stock)
- [Time conventions](#time-conventions)
- [Trade condition codes](#stock-trade-condition-codes)
- [Trade files: broker fills and uploads](#trade-files)
- [Practice journal](#practice-journal-journaltradesjsonl)
- [Slice JSON and HTTP API](#slice-json-and-http-api)
- [Converting other data](#converting-other-data)

## Configuration

Every setting resolves as **environment variable → `config.local.json` → built-in default**.
Copy `config.example.json` to `config.local.json` (git-ignored) and edit it. Relative paths
resolve against the project folder.

| Setting | Default | Meaning |
|---|---|---|
| `THETA_PARQUET` | `data/ThetaData/parquet` | options archive root |
| `THETA_STOCK` | `data/ThetaData/stock` | stock archive root |
| `OPTIONS_FIRST` / `OPTIONS_LAST` | `2020-01-03` / `2026-08-28` | first / last session with option ticks; sessions outside are refused cleanly |
| `STRIKE_WINDOW` | `15` | strikes each side of ATM shipped to the browser |
| `REPLAYER_CACHE` | `cache/` | built slices / history (safe to delete) |
| `REPLAYER_JOURNAL` | `journal/trades.jsonl` | practice trades (private) |
| `ORDER_HISTORY` | `order_history.json` | optional broker fills shown in the **Real** tab, read-only |
| `SCHWAB_REC` | `data/schwab-recordings/parquet` | reserved for a later fallback source; unused today |

Code-level tunables live in `replayer/config.py`:

- `ROOTS` and `STOCK_ROOTS`: the roots the tool knows about.
- `CHART_SYMBOL`: the symbol charted for each root. SPXW is charted as SPY.
- `LAST_SALE_CONDITIONS` and `VWAP_CONDITIONS`: trade-condition filters, explained below.
- `VP_ROW_SIZE`: the volume-profile row height per symbol.
- `HISTORY_MAX_DAYS`: how many prior days can be loaded.
- `SUB_MS`: the sub-second snapshot step.

**Nothing is ever written under the archive roots.** Writes go only to `cache/`,
`journal/` and an Export download.

## Options archive (`THETA_PARQUET`)

One directory per **expiration date**. Inside it, one file per root and tier:

```
{THETA_PARQUET}/YYYY/MM/{EXPIRY}/tick_{ROOT}_{EXPIRY}.parquet           required
{THETA_PARQUET}/YYYY/MM/{EXPIRY}/trade_greeks_{ROOT}_{EXPIRY}.parquet   required for index roots (SPXW)
```

`YYYY/MM` and `{EXPIRY}` (`YYYY-MM-DD`) come from the **expiration**, not the trade date.
Supported roots: `SPY`, `QQQ`, `IWM`, `SPXW`. The date picker is built by scanning these
directory names: a session is offered for `dte = N` when the expiry N NYSE trading days later
has a `tick_` file.

### `tick_{ROOT}_{EXPIRY}.parquet`: per-trade rows carrying the NBBO

| Column | Type | Used for |
|---|---|---|
| `record_ts` | int64, epoch **ms, UTC** | time; parquet filter pushdown on it |
| `sequence` | int64 holding a **32-bit counter** | tie-break within a ms (compared unsigned, see below) |
| `symbol` | string, OSI | contract key, e.g. `SPXW  260828C07740000` |
| `strike` | float | strike ladder |
| `contract_type` | `C` / `P` | |
| `bid`, `ask`, `mid_price` | float | **the pricing contract**: entry = `mid_price`, exit = `bid` |

Rows with a null bid, ask or mid are dropped.

> **A per-expiry file holds every session in that expiry's 0–10 DTE window (about 11 trading
> days).** Rows are always filtered to the chosen session's RTH window by `record_ts`. Never
> treat one file as one day.

### `trade_greeks_{ROOT}_{EXPIRY}.parquet`

Columns read: `record_ts`, `sequence`, `symbol` and `underlying_price` (rows with a price above 0).

This file is the underlying for **SPXW**. An index has no stock tape, so the real SPX level
comes from here. It is also the fallback for a stock root whose `quote_1s` file is missing.

### OSI symbols

The root is space-padded to 6 characters, followed by `YYMMDD`, `C` or `P`, and the strike × 1000
as 8 digits: `SPY   260828C00693000`, `SPXW  260828P07740000`. `trades.parse_osi` also accepts
symbols with the spaces stripped.

## Stock archive (`THETA_STOCK`)

```
{THETA_STOCK}/stock_quote_1s/{SYM}/YYYY/quote_1s_{SYM}_{YYYY-MM-DD}.parquet
{THETA_STOCK}/stock_trade_quote/{SYM}/YYYY/trade_quote_{SYM}_{YYYY-MM-DD}.parquet
{THETA_STOCK}/stock_eod/{SYM}/eod_{SYM}_{YYYY}.parquet
```

| File | Columns read | Used for |
|---|---|---|
| `quote_1s` | `timestamp` (naive **ET**), `bid`, `ask` | underlying mid for SPY / QQQ / IWM (drives strike selection). Crossed or zero quotes are dropped. |
| `trade_quote` | `trade_timestamp` (naive **ET**), `sequence`, `price`, `size`, `condition` | the **chart**: 1s OHLCV, VWAP / σ, volume profile, tape speed, sub-second snapshots, prior-day history |
| `stock_eod` | `created` (datetime), `open`, `high`, `low`, `close`, `volume` | daily bars for 1D EMA / BB (only days **before** the session) |

The chart symbol for SPXW is **SPY** (`CHART_SYMBOL`). An SPXW session therefore needs SPY's
`trade_quote` for that date, plus the SPXW `tick_` and `trade_greeks` files.

## Time conventions

There are two timestamp conventions, and mixing them is the classic bug:

- **Options:** `record_ts` is epoch-ms **UTC**. It is converted to ET once, in the slicer (DST-aware).
- **Stocks:** `timestamp` / `trade_timestamp` are **naive ET wall-clock**. They are never shifted.

Everything downstream uses one axis: **`t` = integer ms since ET midnight of the session
date**. 09:30:00.000 is `34200000`.

The replay window is the **NYSE equity session**, and early closes are respected. The calendar
comes from `pandas_market_calendars` if it is installed, otherwise from a computed NYSE holiday
set. Option rows outside that window are dropped. That includes SPXW's 09:25 pre-open prints,
and the 16:00–16:15 index-option tail is not replayed.

**Order:** rows are sorted by `(record_ts, sequence)` and never by `record_ts` alone, because
many rows share a millisecond. `sequence` is a 32-bit counter stored signed and it **wraps
negative mid-session**, so it is compared as `sequence & 0xFFFFFFFF`. Exact duplicates of
`(symbol, record_ts, sequence)` are dropped.

## Stock trade condition codes

The codes are ThetaData `condition` values. Each was classified empirically by how often it
prints outside the NBBO carried on the same row:

| Codes | Meaning | Used in |
|---|---|---|
| `0` regular, `95` intermarket sweep | last-sale eligible | candle **OHLC**, VWAP, profile, volume |
| `115` odd lot | sub-penny, accurate | VWAP / profile, volume |
| `96`, `4` average-price / derived; `124`, `2`, `66`, `62`, `1`, `11` late, out-of-sequence, prior-reference, blocks | print up to $5 away from the market | **volume only** |

Without this filter the 1s chart grows tall false wicks, such as a block printed at a stale
price. A second that has volume but no eligible print becomes a flat bar at the previous close.

## Trade files

The **Real** and **Uploaded** tabs overlay trades on the chart. Both are read-only and never
simulated.

### Broker fills (`ORDER_HISTORY`, or an uploaded `.json`)

Either `{"fills": {...}}` (an object keyed by fill id), `{"fills": [...]}`, or a bare list of
fill objects:

```json
{"fills": {"a1": {
  "symbol": "SPXW  260828C07750000",
  "asset_type": "OPTION",
  "amount": 1,
  "price": 10.0,
  "mult": 100,
  "net_cash": -1000.65,
  "fee": 0.65,
  "position_effect": "OPENING",
  "is_expiration": false,
  "time": "2026-08-28T14:00:00+0000"
}}}
```

| Field | Required | Notes |
|---|---|---|
| `symbol` | yes | OSI for options; anything else is shown as a non-option trade |
| `amount` | yes | signed quantity: + buy, − sell |
| `time` | yes | ISO-8601. A timezone-less value is taken as **UTC**. Displayed in ET. |
| `price` | | fill price |
| `net_cash` | | signed cash including fees. Summed into the round trip's **P&L**. |
| `fee`, `mult`, `asset_type` | | display |
| `position_effect`, `is_expiration` | | an `OPENING` leg with `is_expiration: true` is the broker's expiry bookkeeping and is ignored |

Fills are paired into **flat-to-flat round trips per symbol, FIFO, across the whole file**.
A position opened on an earlier day and closed today pairs correctly. A trip is shown on a
session if its first entry or last exit falls on that day. Entry and exit prices are
quantity-weighted. P&L appears only once the trip is flat. Shorts and multi-leg trades are
displayed, but only long single options are simulated.

### Practice export (or any list of round trips)

**Export** in the Practice tab downloads the session's journal rows (schema below). Uploading
that file shows it as an overlay, which is handy for comparing two runs of the same day.

The same loader takes any JSON **list of round trips** with `entry_t` (e.g. a strategy's
backtest output): `session_date`, `entry_t` / `exit_t` (ms since ET midnight), `entry_price` /
`exit_price` (or `entry_mid` / `exit_bid`), `pnl`, and optionally `osi` / `symbol`, `type`,
`strike`, `qty`, `tag`, `note`. `pnl` is shown as given (fees included or not, your choice).

An uploaded file is **kept** (browser storage) and re-filtered to each session you load, so a
multi-day file shows each day's trades on that day; **Clear** forgets the files. In BLIND,
trades appear as the clock reaches them; `v` (REVIEW) shows the whole day.

## Practice journal (`journal/trades.jsonl`)

The journal is one JSON object per closed practice round trip, and it is private and
git-ignored. The server recomputes `pnl` and floors times to whole ms.

```json
{"id": "2bac42dbf0a2", "source": "practice", "session_date": "2026-08-28", "root": "SPXW", "dte": 0,
 "expiry": "2026-08-28", "osi": "SPXW  260828P07740000", "strike": 7740, "type": "P", "side": "long_put",
 "qty": 1, "offset": 0, "entry_t": 34624400, "entry_mid": 17.1, "exit_t": 34631449, "exit_bid": 16.7,
 "pnl": -40.0, "mfe": 0, "mae": -40.0, "note": "3rd touch, failed push", "tag": "",
 "after_rewind": false, "after_review": false, "blind_date": false, "created_at": "2026-10-22T06:13:34+00:00"}
```

The fields:

- `entry_t` and `exit_t` are session ms.
- `pnl = (exit_bid − entry_mid) × 100 × qty`.
- `mfe` and `mae` are the best and worst unrealized P&L at the bid while the trade was held.
- `fills` is present only for a **scaled-in** trade, as `[{"t", "mid", "qty"}, …]` in time order.
  The server derives `qty` (the sum), `entry_mid` (the quantity-weighted average), `entry_t` (the
  first fill) and `pnl` from it, ignoring whatever totals the client sent.
- `note` is free text (≤ 1000 chars), editable later by clicking the trade (`PATCH`).
- `after_rewind`: a fill's time had already been watched on an earlier pass (you rewound).
  `after_review`: REVIEW had been opened on this session before the trade. `blind_date`: taken in
  random-blind mode. Older rows lack these three fields; treat a missing field as unknown.

## Watch log (`<journal stem>_watch.jsonl`)

The watch log sits next to the journal; with the default journal it is
`journal/trades_watch.jsonl`. It has one JSON event per line, all sharing `id`, `kind`,
`session_date`, `root`, `dte`, `load_id`, `blind_date` and `logged_at` (server UTC). Times are
session ms.

| `kind` | Extra fields | Meaning |
|---|---|---|
| `load` | `at`, `mode`, `prior_spans`, `wall` | the session was (re)loaded; a new pass starts |
| `span` | `pass`, `from`, `to`, `max_speed`, `wall_from`, `wall_to` | BLIND time `[from, to]` was watched during pass `pass`; long stretches arrive as several contiguous pieces with the same `pass` |
| `jump` | `from`, `to`, `back`, `mode`; optional `rule` | a discontinuity: `back: true` is a rewind; a forward jump skips unwatched time. The next span has a new `pass`. `rule: "zone"` (with `k`, `lead_s`, `big`, `stop`) = an `n` skip: the skipped time stayed inside ±`k`σ of VWAP and had no 1s candle ≥ `big`× the prior 5-min max range, so it was passed over by rule, not missed. `stop` says which rule ended it: `sigma`, `candle` (2 s after the candle), or `close`. `rule: "fixed"` (with `by_s`) = a Ctrl+→ jump. |
| `review` | `at`, `wall` | REVIEW was opened, so the whole day was visible from then on |
| `skip` | `t`, `note`, `pass`, `offset`, `underlying`, `chart`, `wall` | `s`: a setup was seen and deliberately passed on |

"Watched" means the union of `span`s. A 1.8σ+ event inside that union with no trade and no
`skip` was seen and not acted on. Outside it, it wasn't seen.

## Slice JSON and HTTP API

The server listens on localhost only.

| Route | Returns |
|---|---|
| `GET /api/sessions?root=&dte=` | the dates that have data |
| `GET /api/slice?date=&root=&dte=&cadence=1s` | one session (gzipped JSON, below). `404 {error}` for clean "no data". |
| `GET /api/history?date=&root=&days=5` | `days` (≤ 10) prior sessions as 1m bars with each day's VWAP / σ / POC / VAH / VAL and its final profile |
| `GET /api/daily?date=&root=&days=100` | daily bars strictly before `date` |
| `GET /api/quote?date=&root=&dte=&osi=&t=` | the exact bid / ask / mid as of `t` from the full tick tape |
| `GET`, `POST`, `DELETE /api/journal` | read, append, or delete practice trades. `DELETE ?id=` removes one; `?date=&root=` resets a session. |
| `GET /api/broker?date=` | broker round trips touching `date` |
| `POST /api/parse-trades?date=&name=` | parse an uploaded file into round trips |
| `PATCH /api/journal?id=` | `{note}`: set a practice trade's note |
| `GET /api/watch?date=&root=`, `POST /api/watch` | read / append watch-log events (`{events: [...]}`) |
| `PATCH /api/watch?id=` | `{note}`: set a skip's note |
| `GET /api/export` | `{exported_at, journal_file, trades, watch}`: everything, for an analysis |

A slice (`python -m replayer.slicer DATE ROOT DTE --out f.json` writes the same thing):

```
meta:       session_date, root, dte, expiry, open_ms, close_ms, cadence, strike_window,
            atm_strike_at_open, underlying_at_open, strikes[], ladder_source, underlying_source,
            chart_symbol, vp_row_size, option_rows_session, option_rows_emitted, slicer_version
underlying: {t[], p[]}                       1s grid, as-of (drives strike selection)
contracts:  {OSI: {strike, type, t[], bid[], ask[], mid[]}}  ATM ± STRIKE_WINDOW, C and P
chart:      {symbol, ref, t[], o[], h[], l[], c[], v[], n[], vv[], pv[], p2v[],
             sub: {t[], o[], h[], l[], c[], v[], n[]}}
```

**`underlying`**

- A 1s grid, sampled as-of: each point is the last value at or before that second.
- It drives strike selection.

**`contracts`**

- The strikes ATM ± `STRIKE_WINDOW`, for both calls and puts.
- With `cadence=1s`, each second keeps its last row, with that row's real `t`.
- A row is also dropped when its bid, ask and mid all equal the previous row's. Neither step
  changes any as-of value.

**`chart`**

- Bars are stamped at the **end** of their second (`sec·1000 + 999`).
- `v` is the volume of all trades.
- `n` is the trade **count**, which feeds the tape-speed display.
- `vv`, `pv` and `p2v` are the volume, Σ size·(price−ref) and Σ size·(price−ref)² of
  VWAP-eligible trades.
  - The client gets trade-level VWAP = `ref + Σpv/Σvv` and σ² = `Σp2v/Σvv − (Σpv/Σvv)²`.
  - Sums are taken around `ref` (the first eligible price) to keep floating-point error small.
- `sub` holds the forming bar's state at each 250 ms boundary, stamped at the boundary's last ms.
  - A snapshot is written only when trades changed the bar.
  - The last quarter of each second is left out, because the finished 1s bar covers it.

## Converting other data

Any source works if it is written into the layout above. The minimum for one root:

- **Options:** per-expiry `tick_` parquet with the seven columns in the tick table. A NBBO
  update stream is enough, because only `bid` / `ask` / `mid_price` are used. Keep `record_ts`
  in epoch-ms UTC. If there is no exchange sequence, use a per-file increasing counter.
- **Underlying:** `quote_1s` (stock roots) or `trade_greeks.underlying_price` (index roots).
- **Chart:** `trade_quote` for the chart symbol. If you have no condition codes, write `0`;
  bad prints then show through.
- **Daily (optional):** `stock_eod`, used only by the 1D EMA / BB source.

To add a root, extend `ROOTS` / `STOCK_ROOTS` / `CHART_SYMBOL` in `replayer/config.py`, then
add the root to the `#root` select in `web/index.html`. Run `python tests/run_all.py` after any
change. The tests build a tiny synthetic archive (`tests/fixtures.py`), which doubles as a
working example of every file above.
