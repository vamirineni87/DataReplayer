"""Which (root, dte) sessions have option data — for the UI date picker.

Scans the per-expiry directory names once (static archive: one-time harvest)
and maps each expiry back `dte` NYSE trading days to its session date.
"""
import json
import os
from datetime import date, timedelta

from . import config
from . import market_calendar as mc


def trading_days(start: date, end: date) -> list:
    if mc._NYSE is not None:
        return [ts.date() for ts in mc._NYSE.valid_days(start_date=start, end_date=end)]
    out, d = [], start
    while d <= end:
        if mc._is_trading_day_fallback(d):
            out.append(d)
        d += timedelta(days=1)
    return out


def scan_expiries() -> dict:
    """{root: [expiry ISO dates with a tick file]} from the archive layout
    parquet\\YYYY\\MM\\{EXPIRY}\\tick_{ROOT}_{EXPIRY}.parquet. Read-only."""
    found = {r: [] for r in config.ROOTS}
    base = config.THETA_PARQUET
    if not base.exists():
        return found
    for y in sorted(os.scandir(base), key=lambda e: e.name):
        if not (y.is_dir() and y.name.isdigit()):
            continue
        for m in sorted(os.scandir(y.path), key=lambda e: e.name):
            if not m.is_dir():
                continue
            for e in sorted(os.scandir(m.path), key=lambda e: e.name):
                if not e.is_dir():
                    continue
                names = set(os.listdir(e.path))
                for r in config.ROOTS:
                    if f'tick_{r}_{e.name}.parquet' in names:
                        found[r].append(e.name)
    return found


_expiries = None


def expiries(use_cache: bool = True) -> dict:
    """Memoized scan, persisted to the project cache keyed by archive root."""
    global _expiries
    if _expiries is not None and use_cache:
        return _expiries
    path = config.CACHE_DIR / 'expiries.json'
    if use_cache and path.exists():
        blob = json.loads(path.read_text(encoding='utf-8'))
        if blob.get('archive') == str(config.THETA_PARQUET):
            _expiries = blob['expiries']
            return _expiries
    _expiries = scan_expiries()
    if use_cache:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({'archive': str(config.THETA_PARQUET), 'expiries': _expiries}),
                        encoding='utf-8')
    return _expiries


def sessions_for(root: str, dte: int, exp_list=None) -> list:
    """Sorted session-date ISO strings whose dte-th trading day has an expiry file."""
    exp_list = sorted(exp_list if exp_list is not None else expiries().get(root, []))
    if not exp_list:
        return []
    first, last = date.fromisoformat(exp_list[0]), date.fromisoformat(exp_list[-1])
    days = trading_days(first - timedelta(days=dte * 3 + 10), last)
    idx = {d.isoformat(): i for i, d in enumerate(days)}
    out = []
    for e in exp_list:
        i = idx.get(e)
        if i is not None and i - dte >= 0:
            s = days[i - dte]
            if s >= config.OPTIONS_FIRST:
                out.append(s.isoformat())
    return out
