# DataReplayer — feature guide

A tour of the replay UI with screenshots. All shots are real SPXW 0DTE sessions from the archive
(practice trades in them were made on a scratch journal). Run the server with
`python -m replayer.server` and open `http://127.0.0.1:8765/`; press `?` for keys.

## Practice trading

![Trading: SPY 1m + 1s with a closed call and an open put](screenshots/trading.png)

- **`c` / `p`** buy the offset-selected call / put at the option **mid**; **`x`** closes at the
  **bid** — the live hotkey tool's pricing, so practice fills equal reality. Long only, one
  position at a time, BLIND mode only.
- Every fill is **re-priced server-side at the exact millisecond** from the full tick tape.
- **Offset** (`,` `.`) shifts the strike from ATM (+ = OTM); **Qty** with `;` `'`.
- The side panel shows the clock, SPY / VWAP (σ distance) / tape speed / VA / SPX, the CALL and PUT
  quotes at the current offset (with quote age), and the **position card**: entry mid, bid now,
  unrealized P&L and MFE / MAE.
- Trades are drawn on both charts: entry / exit markers and a **dashed entry→exit line with the
  P&L tag**; an open position draws a dotted line to now.
- The **trades list** sits under the quotes in the same panel: tabs **Practice / Real / Uploaded**,
  per-session summary (count, win rate, total P&L), `on chart` toggle, **Upload** (JSON in
  `order_history.json` shape or a practice export), **Export**, and **Reset** (deletes this
  session's practice trades after a confirm). `j` hides / shows it.

## TradingView layout + prior days

![5 prior sessions on the 1m chart, each with its own VWAP, bands and volume profile](screenshots/history.png)

- Default view **TradingView: SPY 1m + 1s** — SPY is the chart proxy for SPXW (strikes still come
  from real SPX).
- Each chart: session **VWAP** (blue) with **±1.8 / 2 / 2.2 / 2.5 / 3σ** bands (2σ orange),
  **volume**, **developing POC / VAH / VAL** and the volume profile, plus the **Tape** histogram
  (trades per bar — the tape's tempo, above volume).
- **History** (0 / 3 / 5 / 10 days) prepends prior sessions to 1m+ panes, each with its own VWAP,
  bands and profile drawn inside its own span.
- OHLC uses only regular / ISO prints (no bad-print wicks); VWAP / σ are exact trade-level values.
- The forming bar updates **4× per second** when trades change it (sub-second replay), so busy
  moments flicker and quiet ones sit still — never ahead of the clock.

## Per-pane indicators

![EMA 20 and Bollinger 20,2 on the 1m pane](screenshots/indicators.png)

- Each pane has its own chips: **VWAP, σ, VP, Vol, Tape, EMA, BB**.
- **EMA** and **BB** take a length and a **source timeframe** (1s … 1h, or **1D**): e.g. BB 20 on
  1m shows the last-20-minutes band on the 1s chart too; EMA 20 on 1D is a 20-day EMA (prior
  daily closes + today's developing close).
- Price scale works like TradingView: auto by default; **scroll or drag the price axis to unlock**
  it, then the chart drags freely up / down. **A** or double-click the axis re-locks; **⟫** jumps
  back to the newest bar.
- Drag the dividers to resize panes and the side panel (remembered).

## Other views

![Classic view: SPX underlying + option C/P mids, REVIEW mode](screenshots/classic.png)

- **View** presets: TradingView (SPY 1m + 1s), **Classic** (underlying + option C/P mids),
  **SPY 1m + options**, or **Custom** — pick Source (SPY trades / Underlying / Options C/P / Hidden)
  and Interval per pane. No view is ever removed.
- **BLIND** (default) hides everything after the clock; **REVIEW** (`v`) shows the whole day and
  refuses trades.

## Picking a session

![Calendar enables only days with data](screenshots/calendar.png)

- The calendar enables only sessions that exist in the archive for the root / DTE (so weekends are
  off for SPX, but would show for a weekend-trading source). `‹` `›` step to the previous / next
  session; **Load** resets the axes to the new day.

## Random blind practice

![Random session with the date hidden](screenshots/random.png)

- **🎲 Random** (`r`) loads a random session with the **date hidden** everywhere — date button,
  meta, Real tab, chart labels (D, D-1, …) — until **Reveal**. Price levels still hint at the era.

## Keys

![Keyboard help](screenshots/help.png)

`space` play / pause · `←` `→` step a bar (Shift = coarsest pane) · `[` `]` speed (0.25× … 60×, Max)
· `Home` / `End` open / close · `g` jump to a time · `v` BLIND / REVIEW · `r` random · `j` trades
list · `?` help.
