"""Tiny synthetic archive in a temp dir, mirroring the real T:\\ layout.

Session 2026-08-28 (EDT, UTC-4), SPXW + SPY, expiry 2026-08-28. Built to hit
every gotcha: a prior-day row in the per-expiry file, SPXW 09:25 pre-open
prints, a sequence wrap inside one ms, an exact duplicate row, and a strike
first listed mid-session.
"""
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd

from replayer import config

SESSION = date(2026, 8, 28)
EXPIRY = date(2026, 8, 28)
PRIOR = date(2026, 8, 27)
OPEN_MS = 9 * 3600_000 + 30 * 60_000           # 09:30 ET as session ms
CLOSE_MS = 16 * 3600_000


def utc_ms(d: date, hh: int, mm: int, ss: int = 0, ms: int = 0) -> int:
    """ET wall-clock on an EDT date -> epoch ms UTC (ET = UTC-4 in August)."""
    return int(datetime(d.year, d.month, d.day, hh + 4, mm, ss, ms * 1000,
                        tzinfo=timezone.utc).timestamp() * 1000)


def osi(root: str, cp: str, strike: float) -> str:
    return f'{root:<6}{EXPIRY:%y%m%d}{cp}{int(strike * 1000):08d}'


def _row(root, cp, strike, ts, seq, bid, ask):
    return dict(sequence=seq, record_ts=ts, symbol=osi(root, cp, strike), root=root,
                expiry=EXPIRY.isoformat(), strike=float(strike), contract_type=cp,
                bid=bid, ask=ask, mid_price=round((bid + ask) / 2, 4))


def spxw_tick_rows():
    rows = []
    for k in range(7700, 7805, 5):                       # ladder known before the open
        rows.append(_row('SPXW', 'C', k, utc_ms(PRIOR, 10, 0), 10, 50.0, 51.0))
        rows.append(_row('SPXW', 'P', k, utc_ms(PRIOR, 10, 0), 11, 40.0, 41.0))
    c = 7750                                             # ATM at the open (underlying 7751)
    rows += [
        _row('SPXW', 'C', c, utc_ms(SESSION, 9, 25), 20, 1.0, 1.2),        # pre-open: excluded
        _row('SPXW', 'C', c, utc_ms(SESSION, 9, 30, 1), 100, 10.0, 10.4),
        _row('SPXW', 'C', c, utc_ms(SESSION, 9, 30, 1, 500), 101, 10.0, 10.4),  # unchanged prices
        _row('SPXW', 'C', c, utc_ms(SESSION, 10, 0), 2147483647, 11.0, 11.4),   # just before wrap
        _row('SPXW', 'C', c, utc_ms(SESSION, 10, 0), -2147483648, 12.0, 12.4),  # wrapped = later
        _row('SPXW', 'C', c, utc_ms(SESSION, 10, 0, 2), 5, 12.5, 12.9),
        _row('SPXW', 'C', c, utc_ms(SESSION, 10, 0, 2), 5, 12.5, 12.9),         # exact duplicate
        _row('SPXW', 'C', c, utc_ms(SESSION, 10, 0, 2), 6, 13.0, 13.4),         # same ms, new seq
        _row('SPXW', 'P', c, utc_ms(SESSION, 9, 31), 200, 9.0, 9.4),
        _row('SPXW', 'C', 9000, utc_ms(SESSION, 11, 0), 300, 0.05, 0.10),      # listed mid-session
    ]
    return pd.DataFrame(rows)


def spxw_greeks_rows():
    pts = [(utc_ms(PRIOR, 10, 0), 1, 7600.0),
           (utc_ms(SESSION, 9, 25), 2, 7700.0),          # pre-open: excluded
           (utc_ms(SESSION, 9, 30, 0, 400), 3, 7751.0),
           (utc_ms(SESSION, 9, 30, 2, 100), 4, 7752.0),
           (utc_ms(SESSION, 12, 0), 5, 7760.0)]
    return pd.DataFrame([dict(record_ts=ts, sequence=s, symbol=osi('SPXW', 'C', 7750),
                              underlying_price=p) for ts, s, p in pts])


def spy_quote_rows():
    ts = pd.to_datetime([f'{SESSION} 09:30:00', f'{SESSION} 09:30:01', f'{SESSION} 16:00:00'])
    return pd.DataFrame({'timestamp': ts, 'bid': [500.00, 500.10, 501.00],
                         'ask': [500.02, 500.12, 501.02], 'symbol': 'SPY'})


def spy_tick_rows():
    rows = []
    for k in range(495, 506):
        rows.append(_row('SPY', 'C', k, utc_ms(PRIOR, 10, 0), 1, 3.0, 3.1))
    rows.append(_row('SPY', 'C', 500, utc_ms(SESSION, 9, 30, 5), 2, 1.5, 1.6))
    return pd.DataFrame(rows)


class FakeArchive:
    """Context manager: writes the fixture archive and points config at it."""

    def __enter__(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self._saved = (config.THETA_PARQUET, config.THETA_STOCK, config.CACHE_DIR)
        config.THETA_PARQUET = root / 'parquet'
        config.THETA_STOCK = root / 'stock'
        config.CACHE_DIR = root / 'project_cache'
        d = config.THETA_PARQUET / '2026' / '08' / EXPIRY.isoformat()
        d.mkdir(parents=True)
        spxw_tick_rows().to_parquet(d / f'tick_SPXW_{EXPIRY}.parquet')
        spxw_greeks_rows().to_parquet(d / f'trade_greeks_SPXW_{EXPIRY}.parquet')
        spy_tick_rows().to_parquet(d / f'tick_SPY_{EXPIRY}.parquet')
        q = config.THETA_STOCK / 'stock_quote_1s' / 'SPY' / '2026'
        q.mkdir(parents=True)
        spy_quote_rows().to_parquet(q / f'quote_1s_SPY_{SESSION}.parquet')
        self.root = root
        return self

    def snapshot(self):
        """{path: (size, mtime_ns)} of everything under the fake archive roots."""
        out = {}
        for base in (config.THETA_PARQUET, config.THETA_STOCK):
            for p in base.rglob('*'):
                st = p.stat()
                out[str(p)] = (st.st_size, st.st_mtime_ns)
        return out

    def __exit__(self, *exc):
        config.THETA_PARQUET, config.THETA_STOCK, config.CACHE_DIR = self._saved
        self._tmp.cleanup()
