"""Archive roots and tunables (SPEC §6).

Each setting resolves as: environment variable > `config.local.json` in the project root
(git-ignored; see `config.example.json`) > the built-in default below.

Archives are READ-ONLY: nothing in this project ever writes under these roots.
"""
import json
import os
from datetime import date
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent

try:
    _LOCAL = json.loads((PROJECT_DIR / 'config.local.json').read_text(encoding='utf-8'))
except FileNotFoundError:
    _LOCAL = {}


def _setting(name: str, default: str) -> str:
    return os.getenv(name) or str(_LOCAL.get(name, default))


def _path(name: str, default: Path) -> Path:
    """A path setting; relative values resolve against the project directory."""
    p = Path(_setting(name, str(default)))
    return p if p.is_absolute() else PROJECT_DIR / p


THETA_PARQUET = _path('THETA_PARQUET', PROJECT_DIR / 'data' / 'ThetaData' / 'parquet')
THETA_STOCK = _path('THETA_STOCK', PROJECT_DIR / 'data' / 'ThetaData' / 'stock')
SCHWAB_REC = _path('SCHWAB_REC', PROJECT_DIR / 'data' / 'schwab-recordings' / 'parquet')

CACHE_DIR = _path('REPLAYER_CACHE', PROJECT_DIR / 'cache')

STRIKE_WINDOW = int(_setting('STRIKE_WINDOW', '15'))

# Options archive horizon (first / last session with option ticks) — SPEC §2a.
OPTIONS_FIRST = date.fromisoformat(_setting('OPTIONS_FIRST', '2020-01-03'))
OPTIONS_LAST = date.fromisoformat(_setting('OPTIONS_LAST', '2026-08-28'))

ROOTS = ('SPY', 'QQQ', 'SPXW', 'IWM')
STOCK_ROOTS = ('SPY', 'QQQ', 'IWM')      # SPXW has no stock tape (index)

# Symbol charted for each option root. SPXW (index, no stock tape) is charted via SPY,
# matching how the operator trades it (SPY as the SPX proxy).
CHART_SYMBOL = {'SPY': 'SPY', 'QQQ': 'QQQ', 'IWM': 'IWM', 'SPXW': 'SPY'}

# Stock trade condition codes (ThetaData `condition`), classified empirically on SPY 2026-08-28
# by how often each code prints outside the prevailing NBBO (trade_quote carries both):
#   0 regular (2% outside) · 95 intermarket sweep (18%, by ~1-2c) · 115 odd lot (sub-penny, <=3c)
#   96 / 4 average-price / derived (76-83% outside, up to 0.69) · 124 / 2 / 66 / 62 / 1 / 11
#   late, out-of-sequence, prior-reference, blocks (up to $5 off).
# Candle OHLC follows TradingView's last-sale rule; VWAP/profile also take odd lots (accurate
# prices); volume bars count every trade.
LAST_SALE_CONDITIONS = (0, 95)
VWAP_CONDITIONS = (0, 95, 115)

# Volume-profile row height per chart symbol (shared by slicer meta, history, and the browser).
VP_ROW_SIZE = {'IWM': 0.02}
VP_ROW_DEFAULT = 0.05


def vp_row_size(sym: str) -> float:
    return VP_ROW_SIZE.get(sym, VP_ROW_DEFAULT)


# Prior-day context on 1m+ chart panes.
HISTORY_MAX_DAYS = 10

# Practice journal (private; git-ignored) and the operator's broker fills (read-only, never written).
JOURNAL_PATH = _path('REPLAYER_JOURNAL', PROJECT_DIR / 'journal' / 'trades.jsonl')
ORDER_HISTORY = _path('ORDER_HISTORY', PROJECT_DIR / 'order_history.json')

# Sub-second replay: snapshots of the forming 1s bar at each SUB_MS boundary (only where trades
# changed it), so the in-progress candle moves with the tape's real tempo within a second.
SUB_MS = 250
