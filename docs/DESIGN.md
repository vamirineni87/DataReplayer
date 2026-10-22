# Design notes

These notes explain how DataReplayer works and why: the rules it keeps and the data quirks it
handles. [`SPEC.md`](SPEC.md) is the original build spec, [`DATA.md`](DATA.md) covers the inputs,
and [`GUIDE.md`](GUIDE.md) is the user-facing tour.

## The point: practice fills equal reality

The tool replays one past session and lets you mark trades with the keys of a live hotkey tool
(`c` buy call, `p` buy put, `x` close). Practice is only worth something if every fill is priced
exactly as a real one would have been, and if the screen never shows anything you couldn't have
known at that moment. Those two properties set almost every decision below.

### Pricing contract

- **Entry** = the option's `mid_price` as of the clock. **Exit** = its `bid` as of the clock.
- `pnl = (exit_bid − entry_mid) × 100 × qty`.
- **Long only, one position at a time.** `c` and `p` are refused while you hold a position; `x`
  is refused while you are flat. Nothing is ever sold to open.
- **Strike pick:** take the nearest strike to the current underlying, then shift it by
  `offset`, where + means OTM (calls go up, puts go down). The result is clamped to the shipped
  ladder.
- **Exact re-pricing.** The browser prices a mark instantly from its 1s data. It then asks
  `/api/quote` for the exact row as of that millisecond, from the full tick tape (a per-contract
  LRU), and the journal stores the exact price.
  - The clock is fractional during playback, so marks are floored to a whole ms on both client
    and server.
  - An early bug sent the fractional ms as is, `int()` rejected it, and the toast read "exact
    reprice failed".
- MFE and MAE are the best and worst unrealized P&L at the bid while the trade is held.

## No look-ahead: the integrity core

> A price "as of clock T" is the last row with timestamp ≤ T. Data may be stale; it is never early.

All look-ahead-sensitive logic lives in `web/engine.js`. It is pure code with no DOM access, and
it is unit-tested in Node by `tests/test_engine.js`. Each of these rules exists because an obvious
shortcut leaks future data.

| Where | Rule | The leak it prevents |
|---|---|---|
| 1s chart bars | stamped at the **end** of their second (`sec·1000+999`) | a bar stamped at its start would show its close up to 999 ms early |
| `cadence=1s` option data | keep the **last** row per second with its **real** `t` | resampling to the second's start would show a quote early |
| Change-only compression | drop rows whose bid / ask / mid equal the previous row | none: lossless for as-of lookups |
| Partial bars | a 1m / 5m bar is built only from samples ≤ clock | the bar's final high / low / close |
| Sub-second replay | forming-bar snapshots at 250 ms boundaries, stamped at the boundary's last ms, never at the start | intra-second ticks shown early |
| Strike ladder | strikes **first seen at or before the open**; ATM from the first underlying sample | strikes listed later in the day hint at where price went |
| Volume profile / POC / VAH / VAL | a **developing** value per second | the final profile reveals the day's acceptance zones |
| VWAP / σ bands | cumulative to the clock | |
| EMA / BB on a higher timeframe | completed source closes **plus the price as of the instant** (TradingView's developing value) | using the source bar's final close |
| 1D source | daily bars strictly **before** the session, plus today's developing price | today's eod close |
| Prior-day history | whole past sessions only | none: they are entirely in the past |
| Trade markers and P&L lines | an exit marker or connector appears only once the clock reaches it | seeing how a trade ended |
| Tape speed | finished seconds only | |
| REVIEW mode | an explicit toggle (`v`); refused while holding a position, and trades are refused in REVIEW | marking trades with the whole day visible |
| Seeking | can't seek before an open position's entry | un-doing a trade by rewinding |
| Random blind | the date is hidden in the date button, meta line, Real tab and chart labels (D, D-1, …) | recognising the session. Price levels still hint at the era; that is accepted. |

There is **no forward interpolation**: SPEC §4B originally proposed it for smoothness, and it
was removed because interpolating toward the next sample is a leak. Smoothness comes from the
`requestAnimationFrame` clock and incremental `series.update()` calls.

## Data quirks handled

- **Two timestamp conventions.** Options use epoch-ms UTC; stocks use naive ET. The slicer
  converts options to ET once, DST-aware. Downstream everything is `t` = ms since ET midnight.
- **Per-expiry files span about 11 sessions.** Reads always push down a `record_ts` filter to
  the session's RTH window.
- **The `sequence` counter wraps.** It is a 32-bit exchange counter stored signed, and it goes
  negative mid-session in real data. Sorting by `(record_ts, sequence)` therefore compares it
  unsigned (`seq & 0xFFFFFFFF`). Many rows share a millisecond, so `record_ts` alone is never
  enough.
- **Bad prints.** Average-price, late, out-of-sequence and block prints (codes 96 / 4 / 124 / 2 /
  …) sit up to $5 off the market and painted vertical spikes on the 1s chart. Only regular and
  ISO prints form candles; odd lots also count toward VWAP and the profile; volume counts
  everything (see [DATA.md](DATA.md#stock-trade-condition-codes)).
  - These codes were classified empirically, against the NBBO carried on each trade row.
- **SPXW has no stock tape.** SPX is an index and doesn't trade. Strikes come from the real SPX
  level in `trade_greeks.underlying_price`, while the **chart** shows SPY trades as the SPX
  proxy, matching how the author trades it.
- **No 16:15 tail.** The archive has no option rows after 16:00 ET for any root, so the replay
  window is the equity session, with early closes respected. SPXW's 09:25 pre-open prints are
  dropped.
- **Thin pre-open chain.** If fewer than 3 strikes are known at the open, the ladder falls back
  to the strikes that traded in the session. `meta.ladder_source` says which was used.
- **VWAP precision.** The per-second sums are taken around a reference price, so σ comes out
  exact at the trade level without catastrophic cancellation.
- **eod vs. the 16:00 close.** The stock eod close matches the last regular trade within cents,
  so it is safe as the prior-day close for 1D indicators.

## Architecture

```
archive (read-only parquet) ─► slicer.py / history.py / trades.py ─► server.py (localhost, stdlib)
                                       │ cache/ (JSON, versioned)          │ gzip JSON
                                       ▼                                   ▼
                               web/engine.js (pure, tested) ◄── web/app.js (panes, HUD, journal)
```

- **Slicer** (`replayer/slicer.py`) turns `(date, root, dte)` into one JSON per session.
  - The expiry is the `dte`-th NYSE trading day on or after the date.
  - Option files are read with column projection and pushdown.
  - Output is cached in `cache/`, keyed by its arguments plus `SLICER_VERSION`. Cold builds take
    3–8 s. An SPXW 0DTE slice is about 10 MB raw and about 3 MB gzipped.
  - `prune_cache()` runs at server start and deletes files built by older versions. Bump
    `SLICER_VERSION` or `HISTORY_VERSION` whenever their output changes.
- **History** (`replayer/history.py`) turns N prior sessions into 1m bars.
  - It uses the same `chart_bars` code and the same condition filter as the live slice.
  - Each day carries its own VWAP / σ, a developing POC / VAH / VAL, and its final profile.
  - The cache holds one file per (symbol, day).
- **Trades** (`replayer/trades.py`) holds the exact `quote_at` lookup, the journal
  (append / read / delete / reset), and the pairing of broker fills into round trips.
- **Sessions** (`replayer/sessions.py`) scans the expiry directory names once into
  `cache/expiries.json`, so the date picker enables only days with data. A source that trades on
  weekends would show weekends.
- **Server** (`replayer/server.py`) is a stdlib `ThreadingHTTPServer` bound to 127.0.0.1.
  - It serves static files only from `web/`, with a traversal guard.
  - A clean `NoData` error becomes a 404 with `{error}`.
- **UI** (`web/`) has no build step. It loads lightweight-charts 4.2.0, pinned, from unpkg.
  - It shows two `Pane`s, each with a **source** (`chart`, `underlying`, `options`, `none`) and
    its own interval. View presets just configure both panes; no view is ever removed.
  - A pane is a list of layers `{series, full(j), partial(k)}`, rendered generically. Going
    forward it calls `update()`; any seek, backwards move or mode change triggers a full
    `setData`.
  - One master clock runs on `requestAnimationFrame`, with dt clamped to 250 ms so a background
    tab can't jump the replay.

### Indicator details

- **Volume profile.**
  - Each second's VWAP-eligible volume goes into the row of that second's VWAP price.
  - The row height is $0.05 by default and $0.02 for IWM.
  - The value area is 70%, grown from the POC toward the larger neighbour; ties keep the earlier
    POC.
  - The profile is drawn by a series primitive: prior days inside their own span, today's at its
    open, or at the left edge when the open is scrolled out of view.
- **VWAP bands** sit at ±1.8 / 2 / 2.2 / 2.5 / 3σ. VWAP is blue and 2σ is orange; the others are
  gray. Bands, VA lines and BB are excluded from autoscale.
- **EMA and BB** are set per pane, each with a length and a **source timeframe**: 1s … 5m, 15m,
  30m, 1h or 1D. For example, BB 20 on 1m draws the same "last 20 minutes" band on a 1s chart.
  - The EMA is seeded with an SMA.
  - On 1m and coarser sources, values are warmed up over the loaded history.
- **Tape** is a trades-per-bar histogram on its own scale above volume. The HUD shows trades per
  second over the last 10 s against the session average, and highlights it at 2× or more.
- **Sub-second replay.** The forming bar updates up to 4×/s, and only when trades actually
  changed it. Busy moments therefore tick quickly and quiet ones stay still, like TradingView,
  without leaking the second's final state.

### Chart interaction (TradingView-like)

- The price scale is **auto** by default; dragging the chart pans time only.
- Scrolling or dragging the price axis **unlocks** it. After that, wheel zoom works around the
  cursor price, the chart drags freely up and down, and playback stops rescaling.
  - **A**, or a double-click on the axis, re-locks it.
  - lightweight-charts 4.2 has no public price-range setter, so the unlocked range is served
    through the main series' `autoscaleInfoProvider`, and every other series reports `null`.
- **Follow mode.** While the newest bar is in view, playback slides the view along.
  - Dragging away turns follow off, and **⟫** brings it back.
  - The replay never moves the view mid-drag.
  - After a `setData` the visible range is restored, because the library would otherwise keep its
    right gap and shove bars off-screen.
- **Load / seek** re-centres on the clock's bar. With history the session opens near the left;
  without it, mid-pane. A fresh load resets the axes to auto.
- Panes sync their logical ranges only when their intervals match. Crosshair positions sync by
  time.
- Chart times are fake-UTC seconds displayed as ET wall-clock time.

## Privacy and safety

- **Read-only archives.** Nothing writes under the data roots.
- **No orders, no broker, no live data, ever.** No OAuth, no network trading, no streaming. The
  server binds to localhost.
- The journal, uploads, `order_history.json`, `config.local.json` and `cache/` are git-ignored.
  The broker file is only ever opened for reading.
- The tests run entirely on a synthetic archive in a temp directory (`tests/fixtures.py`) and
  redirect the journal and broker paths, so they never touch real data. A test that needs the
  real archive skips itself when the archive is absent.

## Testing

```
python tests/run_all.py                       # everything (Python + the Node engine tests)
python tests/run_all.py slicer as_of          # filter by module / test name
node tests/test_engine.js                     # engine only
```

Covered:

- expiry resolution;
- UTC→ET conversion (SPXW 0DTE first and last rows at about 09:30 and 16:00);
- the session date filter;
- `(record_ts, unsigned sequence)` ordering;
- as-of correctness and never-early stamping (bars, sub-second snapshots, option cadence);
- strike selection;
- P&L math and exact re-pricing;
- journal append / delete / reset;
- round-trip pairing (scale in/out, overnight carry, expiry bookkeeping legs, shorts);
- condition filtering;
- developing profile / VWAP;
- MTF EMA / BB;
- daily bars strictly before the session;
- the HTTP routes.

For manual UI checks that involve trading, run a second server with
`REPLAYER_JOURNAL=<scratch file>` so practice marks don't pollute your journal.

## Known limits and ideas

- Option data ends at the archive horizon (`OPTIONS_LAST`).
- Index options are replayed only during equity hours.
- Not built yet:
  - AUTO strike-by-delta (target |Δ| 0.55);
  - tick-size rounding;
  - bracket orders;
  - CSV column mapping for uploads;
  - notes / tags editing;
  - drawing tools;
  - watching a strike other than the current offset.
- Random-blind hides dates, not price levels.
