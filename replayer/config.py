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
