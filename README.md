# DataReplayer

A local, browser-based **historical option replay trainer**. Replay a past trading day
from a local ThetaData tick archive and practice 0–2 DTE options entries with the same
keys as the live hotkey tool (`c` buy call / `p` buy put / `x` close) — each marked trade
priced exactly as the live tool prices (entry at the option **mid**, exit at the option
**bid**), so practice fills equal reality.

> Training/replay only. **Not** a backtester, **not** a live trader, never places orders.

![DataReplayer: SPY 1m + 1s with VWAP bands, volume profile, practice trades and the side panel](docs/screenshots/trading.png)

**Feature tour with screenshots: [`docs/GUIDE.md`](docs/GUIDE.md).**

## Start here
1. **[`docs/SPEC.md`](docs/SPEC.md)** — the full build spec (architecture, data, pricing contract, phases).
2. **`T:\data\ThetaData\THETA_ARCHIVE_HANDOFF.md`** — authoritative data provenance; read before touching data.
3. **`CLAUDE.md`** — build guardrails (read-only archives, privacy, tests).

## Data (read-only, on the `T:` NAS)
- Options tick/greeks: `T:\data\ThetaData\parquet\` — SPY/QQQ/SPXW/IWM, 0–10 DTE, 2020 → 2026-08-28.
- Stock 1s/trade quotes: `T:\data\ThetaData\stock\` — SPY/QQQ/IWM, 2018 → present.

## Run
```
python -m replayer.server            # http://127.0.0.1:8765/  (localhost only)
python -m replayer.slicer 2026-08-28 SPXW 0 --out spxw.json   # slice one session (CLI)
python tests/run_all.py              # offline tests
```
Deep link: `/?root=SPXW&dte=0&date=2026-08-28&t=10:32&mode=review&view=tv`. Press `?` in the UI for keys.

Views: **TradingView** (SPY 1m + SPY 1s, VWAP ±1.8/2/2.2/2.5/3σ bands, volume, tape speed,
developing POC/VAH/VAL + volume profile — SPY is the chart proxy for SPXW), **Classic** (underlying +
option C/P mids), **SPY 1m + options**, or **Custom** (pick Source + Interval per pane).
**History** adds 0/3/5/10 prior days to 1m+ panes, each with its own VWAP and volume profile.
Per-pane indicator chips; EMA / BB take a length and a source timeframe (1s … 1h, or 1D for e.g. a
20-day EMA). The forming bar updates 4×/s with the tape (never ahead of the clock).

Trading: `c` / `p` buy the offset-selected call / put at the mid, `x` closes at the bid (BLIND
only, long only, one position; re-priced at the exact ms); `,` `.` offset, `;` `'` qty. Trades draw
entry→exit lines with P&L. The trades list lives in the right-hand panel under the quotes: Practice
(`journal/trades.jsonl`, private, git-ignored; Export / Reset), Real (from the companion repo's
`order_history.json`, read-only) and Uploaded (drop a JSON in `order_history.json` shape or a
practice export). Price axis: scroll or drag to unlock (then the chart pans freely), **A** /
double-click re-locks. 🎲 Random (`r`) loads a random session with the date hidden until Reveal.

## Stack
Python (`pandas` + `pyarrow`) slicer + stdlib HTTP server; static HTML + TradingView
**lightweight-charts** (MIT). Windows 11. No build step, no cloud, no database.

## MVP (SPEC §7, end of Phase 3)
Load SPXW 2026-08-28 0DTE → play from 09:30 ET → `c` → unrealized P&L tracks the bid →
`x` → realized P&L = `(exit_bid − entry_mid) × 100`, read-only and with no look-ahead.
