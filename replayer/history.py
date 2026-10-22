"""Prior-day context for the 1m chart: N previous sessions, each reduced to 1-minute bars
with that day's own session VWAP/σ, developing POC/VAH/VAL, and its final volume profile.

These days are entirely before the replayed session, so showing them is not look-ahead.
Built from the same 1s chart bars as the live session (`slicer.chart_bars`), so trade-condition
filtering and the profile algorithm match the browser (web/engine.js profileSeries):
each 1s bar's VWAP-eligible volume lands on the row of its own VWAP; value area = 70%,
grown from the POC toward the larger neighbour. One cache file per (symbol, day).
"""
import json
from datetime import date, timedelta

import numpy as np

from . import config, sessions, slicer

HISTORY_VERSION = 1
VA_PCT = 0.7


def value_area(H: np.ndarray, lo0: int, hi0: int, poc: int, total: float):
    lo = hi = poc
    acc = H[poc]
    target = total * VA_PCT
    while acc < target:
        up = H[hi + 1] if hi + 1 <= hi0 else -1
        dn = H[lo - 1] if lo - 1 >= lo0 else -1
        if up < 0 and dn < 0:
            break
        if up >= dn:
            hi += 1; acc += up
        else:
            lo -= 1; acc += dn
    return lo, hi


def day_summary(sym: str, day: date) -> dict:
    """1m bars + per-minute indicators + final profile for one prior session."""
    open_ms, close_ms = slicer.session_bounds(day)
    c = slicer.chart_bars(sym, day, open_ms, close_ms)
    t = np.asarray(c['t']) - 999                       # second start
    o, h, l, cl = (np.asarray(c[k], dtype=float) for k in ('o', 'h', 'l', 'c'))
    v, vv = np.asarray(c['v'], dtype=float), np.asarray(c['vv'], dtype=float)
    pv, p2v = np.asarray(c['pv'], dtype=float), np.asarray(c['p2v'], dtype=float)
    ref, row_size = c['ref'], config.vp_row_size(sym)
    n_min = int(np.ceil((close_ms - open_ms) / 60000))
    minute = np.minimum((t - open_ms) // 60000, n_min - 1).astype(int)

    # session VWAP / σ at each second, then sampled at each minute's last second
    V, PV, P2V = np.cumsum(vv), np.cumsum(pv), np.cumsum(p2v)
    with np.errstate(invalid='ignore', divide='ignore'):
        m = np.where(V > 0, PV / V, 0.0)
        sd = np.sqrt(np.maximum(0.0, np.where(V > 0, P2V / V, 0.0) - m * m))
    vwap = ref + m

    # profile rows (same rule as engine.profileRows)
    with np.errstate(invalid='ignore', divide='ignore'):
        px = np.where(vv > 0, ref + pv / vv, cl)
    row = np.round(px / row_size).astype(int)
    base = row.min()
    row -= base
    H = np.zeros(row.max() + 2)
    up_vol, dn_vol = np.zeros_like(H), np.zeros_like(H)

    out = {k: [] for k in ('t', 'o', 'h', 'l', 'c', 'v', 'vwap', 'sd', 'poc', 'vah', 'val')}
    total, lo0, hi0, poc = 0.0, len(H), -1, -1
    for mi in range(n_min):
        idx = np.nonzero(minute == mi)[0]
        if len(idx) == 0:
            continue
        for i in idx:                                   # incremental, like the browser
            r = row[i]
            H[r] += vv[i]; total += vv[i]
            (up_vol if cl[i] >= o[i] else dn_vol)[r] += vv[i]
            lo0, hi0 = min(lo0, r), max(hi0, r)
            if poc < 0 or H[r] > H[poc]:
                poc = r
        lo, hi = value_area(H, lo0, hi0, poc, total) if total > 0 else (poc, poc)
        last = idx[-1]
        out['t'].append(int(open_ms + mi * 60000))
        out['o'].append(float(o[idx[0]])); out['h'].append(float(h[idx].max()))
        out['l'].append(float(l[idx].min())); out['c'].append(float(cl[last]))
        out['v'].append(int(v[idx].sum()))
        out['vwap'].append(round(float(vwap[last]), 4)); out['sd'].append(round(float(sd[last]), 5))
        out['poc'].append(round(float((base + poc) * row_size), 4))
        out['vah'].append(round(float((base + hi) * row_size), 4))
        out['val'].append(round(float((base + lo) * row_size), 4))

    lo, hi = value_area(H, lo0, hi0, poc, total) if total > 0 else (poc, poc)
    rows = [[round(float((base + r) * row_size), 4), int(up_vol[r]), int(dn_vol[r])]
            for r in range(lo0, hi0 + 1) if H[r] > 0]
    out.update({
        'date': day.isoformat(), 'open_ms': open_ms, 'close_ms': close_ms,
        'profile': {'row_size': row_size, 'rows': rows,
                    'va': [round(float((base + lo) * row_size), 4), round(float((base + hi) * row_size), 4)],
                    'poc': round(float((base + poc) * row_size), 4)},
    })
    return out


def prior_days(sym: str, session_date: date, n: int) -> list:
    """The n trading days before session_date that have a trade tape, oldest first."""
    if n <= 0:
        return []
    days = sessions.trading_days(session_date - timedelta(days=n * 2 + 14), session_date - timedelta(days=1))
    have = [d for d in days if slicer.stock_trade_path(sym, d).exists()]
    return have[-n:]


def cache_path(sym: str, day: date):
    return config.CACHE_DIR / f'hist_{sym}_{day.isoformat()}_v{HISTORY_VERSION}_{slicer.SLICER_VERSION}.json'


def get_day(sym: str, day: date, use_cache: bool = True) -> dict:
    path = cache_path(sym, day)
    if use_cache and path.exists():
        return json.loads(path.read_text(encoding='utf-8'))
    d = day_summary(sym, day)
    if use_cache:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(d, separators=(',', ':')), encoding='utf-8')
        tmp.replace(path)
    return d


def history(root: str, session_date: date, n: int, use_cache: bool = True) -> dict:
    sym = config.CHART_SYMBOL[root]
    n = max(0, min(int(n), config.HISTORY_MAX_DAYS))
    return {'symbol': sym, 'row_size': config.vp_row_size(sym),
            'days': [get_day(sym, d, use_cache) for d in prior_days(sym, session_date, n)]}


# ------------------------------------------------------------------ daily bars (1D indicators)

def stock_eod_path(sym: str, year: int):
    return config.THETA_STOCK / 'stock_eod' / sym / f'eod_{sym}_{year}.parquet'


def daily_bars(root: str, session_date: date, n: int = 100) -> dict:
    """The n daily bars of the chart symbol strictly BEFORE session_date (oldest first), from the
    stock eod tier (read-only). The session's own daily close is the future, so it is never
    included; the browser supplies today's developing close (price as of the clock)."""
    import pandas as pd
    sym = config.CHART_SYMBOL[root]
    n = max(1, min(int(n), 400))
    frames = []
    for y in range(session_date.year, session_date.year - 3, -1):
        p = stock_eod_path(sym, y)
        if p.exists():
            frames.append(pd.read_parquet(p, columns=['created', 'open', 'high', 'low', 'close', 'volume']))
        if sum(len(f) for f in frames) > n + 5:
            break
    if not frames:
        return {'symbol': sym, 'days': []}
    d = pd.concat(frames)
    d['date'] = d['created'].dt.date
    d = d[(d['date'] < session_date) & (d['close'] > 0)].sort_values('date').drop_duplicates('date', keep='last').tail(n)
    return {'symbol': sym, 'days': [{'date': r.date.isoformat(), 'o': float(r.open), 'h': float(r.high),
                                     'l': float(r.low), 'c': float(r.close), 'v': int(r.volume)}
                                    for r in d.itertuples()]}
