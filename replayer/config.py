"""Archive roots and tunables. Env vars override defaults (SPEC §6).

Archives are READ-ONLY: nothing in this project ever writes under these roots.
"""
import os
from datetime import date
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent

THETA_PARQUET = Path(os.getenv('THETA_PARQUET', r'T:\data\ThetaData\parquet'))
THETA_STOCK = Path(os.getenv('THETA_STOCK', r'T:\data\ThetaData\stock'))
SCHWAB_REC = Path(os.getenv('SCHWAB_REC', r'T:\data\schwab-recordings\parquet'))

CACHE_DIR = Path(os.getenv('REPLAYER_CACHE', str(PROJECT_DIR / 'cache')))

STRIKE_WINDOW = int(os.getenv('STRIKE_WINDOW', '15'))

# Options archive horizon (one-time bulk harvest) — SPEC §2a.
OPTIONS_FIRST = date(2020, 1, 3)
OPTIONS_LAST = date(2026, 8, 28)

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
