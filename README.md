# DataReplayer

A local, browser-based **historical option replay trainer**. Replay a past trading day
from a local ThetaData tick archive and practice 0–2 DTE options entries with the same
keys as the live hotkey tool (`c` buy call / `p` buy put / `x` close) — each marked trade
priced exactly as the live tool prices (entry at the option **mid**, exit at the option
**bid**), so practice fills equal reality.

> Training/replay only. **Not** a backtester, **not** a live trader, never places orders.

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
Deep link: `/?root=SPXW&dte=0&date=2026-08-28&t=10:32&mode=review`. Press `?` in the UI for keys.

## Stack
Python (`pandas` + `pyarrow`) slicer + stdlib HTTP server; static HTML + TradingView
**lightweight-charts** (MIT). Windows 11. No build step, no cloud, no database.

## MVP (SPEC §7, end of Phase 3)
Load SPXW 2026-08-28 0DTE → play from 09:30 ET → `c` → unrealized P&L tracks the bid →
`x` → realized P&L = `(exit_bid − entry_mid) × 100`, read-only and with no look-ahead.
