"""Layer 1 — Slicer (SPEC §4).

(session_date, root, dte) -> compact JSON for one replay session:
underlying on a 1s grid (drives strike selection) + option bid/ask/mid for
ATM ± STRIKE_WINDOW strikes + 1s OHLCV bars of the chart symbol (SPY for SPXW).

Integrity rules this module owns (SPEC §5):
- Time axis everywhere downstream is `t` = integer ms since ET midnight of the
  session date. Options `record_ts` (epoch-ms UTC) is converted here, once;
  stock `timestamp` is already naive ET and is NOT shifted.
- Per-expiry option files merge ~11 trading days: rows are filtered to the
  session's RTH window.
- Order is (record_ts, sequence). `sequence` is a 32-bit exchange counter that
  wraps negative mid-session in the archive (signed int64 storage), so it is
  compared as unsigned (`seq & 0xFFFFFFFF`).
- No look-ahead: every resample is an as-of (last row with t <= T) and keeps
  the row's real timestamp, so a sample can be stale but never early. The
  strike ladder is the chain as known at the open (strikes first seen at or
  before the open), so later-listed strikes can't hint at the day's range.

CLI:  python -m replayer.slicer 2026-08-28 SPXW 0 [--out FILE] [--cadence 1s|trade]
"""
import argparse
import json
import sys
from datetime import date, datetime, time as dtime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from . import config
from .market_calendar import is_trading_day, next_trading_days, rth_bounds

SLICER_VERSION = 5
ET = ZoneInfo('America/New_York')
DAY_MS = 86_400_000

OPTION_COLS = ['record_ts', 'sequence', 'symbol', 'strike', 'contract_type',
               'bid', 'ask', 'mid_price']


class NoData(Exception):
    """A clear, user-facing 'no data for this selection' (SPEC §5 rule 7)."""


# ------------------------------------------------------------------ time

def et_midnight_utc_ms(d: date) -> int:
    return int(datetime.combine(d, dtime(0), ET).timestamp() * 1000)


def utc_ms_to_session_ms(record_ts, session_date: date) -> np.ndarray:
    """Epoch-ms UTC -> ms since ET midnight of `session_date` (DST-aware).
    Rows from other ET dates fall outside [0, DAY_MS)."""
    et = pd.to_datetime(np.asarray(record_ts, dtype='int64'), unit='ms', utc=True)
    et = et.tz_convert(ET).tz_localize(None)
    return ((et - pd.Timestamp(session_date)) // pd.Timedelta(milliseconds=1)).to_numpy('int64')


def naive_et_to_session_ms(ts, session_date: date) -> np.ndarray:
    """Naive-ET stock timestamps -> ms since ET midnight. No tz shift."""
    ts = pd.to_datetime(ts)
    return ((ts - pd.Timestamp(session_date)) // pd.Timedelta(milliseconds=1)).to_numpy('int64')


def session_bounds(session_date: date):
    """(open_ms, close_ms) of the NYSE equity session (early closes respected).
    The archive holds no option rows after 16:00 ET for any root (SPXW's
    16:15 tail was not harvested), so the equity session is the replay window."""
    o, c = rth_bounds(session_date)
    if o is None:
        raise NoData(f'{session_date} is not an NYSE trading day')
    mid = datetime.combine(session_date, dtime(0), ET)
    return int((o - mid).total_seconds() * 1000), int((c - mid).total_seconds() * 1000)


def fmt_ms(ms: int) -> str:
    s, ms = divmod(int(ms), 1000)
    h, s = divmod(s, 3600)
    m, s = divmod(s, 60)
    return f'{h:02d}:{m:02d}:{s:02d}.{ms:03d}'


# ------------------------------------------------------------------ paths

def resolve_expiry(session_date: date, dte: int) -> date:
    """The dte-th NYSE trading day >= session_date (0 = same day)."""
    if dte < 0:
        raise ValueError('dte must be >= 0')
    if not is_trading_day(session_date):
        raise NoData(f'{session_date} is not an NYSE trading day')
    return next_trading_days(dte + 1, session_date)[dte]


def option_path(tier: str, root: str, expiry: date) -> Path:
    e = expiry.isoformat()
    return config.THETA_PARQUET / f'{expiry:%Y}' / f'{expiry:%m}' / e / f'{tier}_{root}_{e}.parquet'


def stock_quote_path(sym: str, d: date) -> Path:
    return config.THETA_STOCK / 'stock_quote_1s' / sym / f'{d:%Y}' / f'quote_1s_{sym}_{d.isoformat()}.parquet'


def stock_trade_path(sym: str, d: date) -> Path:
    return config.THETA_STOCK / 'stock_trade_quote' / sym / f'{d:%Y}' / f'trade_quote_{sym}_{d.isoformat()}.parquet'


# ------------------------------------------------------------------ core helpers

def seq_key(seq) -> np.ndarray:
    """Unsigned view of the 32-bit exchange sequence (see module docstring)."""
    return np.asarray(seq, dtype='int64') & 0xFFFFFFFF


def sort_ticks(df: pd.DataFrame) -> pd.DataFrame:
    """Order by (record_ts, unsigned sequence); drop exact (symbol, record_ts,
    sequence) duplicates. Never dedups on record_ts alone."""
    df = df.assign(_seq=seq_key(df['sequence']))
    df = df.sort_values(['record_ts', '_seq'], kind='stable')
    df = df.drop_duplicates(['symbol', 'record_ts', 'sequence'], keep='last')
    return df.drop(columns='_seq').reset_index(drop=True)


def as_of_index(t: np.ndarray, at) -> np.ndarray:
    """Index of the last sample with t <= at (-1 if none). `t` must be sorted.
    This is THE no-look-ahead primitive."""
    return np.searchsorted(t, at, side='right') - 1


def price_as_of(t: np.ndarray, values: np.ndarray, at: int):
    i = int(as_of_index(t, at))
    return None if i < 0 else values[i]


def as_of_grid(t: np.ndarray, values: np.ndarray, grid: np.ndarray):
    """Sample `values` onto `grid` with as-of semantics; grid points before the
    first sample are dropped."""
    idx = as_of_index(t, grid)
    keep = idx >= 0
    return grid[keep], values[idx[keep]]


def last_per_second(t: np.ndarray) -> np.ndarray:
    """Boolean mask keeping the last row of each wall-clock second (t sorted).
    Kept rows retain their real t, so as-of reads stay stale-not-early."""
    sec = t // 1000
    keep = np.ones(len(t), dtype=bool)
    if len(t) > 1:
        keep[:-1] = sec[1:] != sec[:-1]
    return keep


def changed_rows(*cols) -> np.ndarray:
    """Boolean mask keeping a row only if any column differs from the previous
    row. Lossless for as-of reads: a dropped row repeats the prices of the row
    before it, which an as-of lookup returns instead."""
    n = len(cols[0])
    keep = np.ones(n, dtype=bool)
    if n > 1:
        diff = np.zeros(n - 1, dtype=bool)
        for c in cols:
            c = np.asarray(c)
            diff |= c[1:] != c[:-1]
        keep[1:] = diff
    return keep


def strike_window(ladder, price: float, n: int):
    """(atm_strike, window) — window = ATM ± n positions on the ladder. ATM is
    the nearest strike (ties -> lower), same as the live tool's atm_strike()."""
    ladder = np.asarray(sorted(ladder), dtype=float)
    i = int(np.argmin(np.abs(ladder - price)))
    return float(ladder[i]), [float(s) for s in ladder[max(0, i - n): i + n + 1]]


def pick_strike(window, price: float, option_type: str, offset: int) -> float:
    """Live tool's OptionWindow.pick: ATM index + offset (+ = OTM), clamped.
    option_type 'C' or 'P'."""
    window = sorted(window)
    i = int(np.argmin(np.abs(np.asarray(window) - price)))
    target = i - offset if option_type == 'P' else i + offset
    return float(window[max(0, min(target, len(window) - 1))])


# ------------------------------------------------------------------ readers

def read_option_session(root: str, expiry: date, session_date: date, open_ms: int, close_ms: int):
    """All option rows for the session RTH window, sorted, with `t` (session ms)."""
    path = option_path('tick', root, expiry)
    if not path.exists():
        raise NoData(f'no {root} tick file for expiry {expiry} ({path})')
    base = et_midnight_utc_ms(session_date)
    df = pd.read_parquet(path, columns=OPTION_COLS,
                         filters=[('record_ts', '>=', base + open_ms), ('record_ts', '<=', base + close_ms)])
    df['t'] = utc_ms_to_session_ms(df['record_ts'].to_numpy(), session_date)
    df = df[(df['t'] >= open_ms) & (df['t'] <= close_ms)]          # belt and braces vs. DST math
    df = df.dropna(subset=['bid', 'ask', 'mid_price'])
    if df.empty:
        raise NoData(f'{root} expiry {expiry} has no option rows on {session_date} RTH')
    return sort_ticks(df)


def ladder_known_at_open(root: str, expiry: date, session_date: date, open_ms: int) -> list:
    """Strikes first seen (any contract type) at or before the session open."""
    path = option_path('tick', root, expiry)
    cutoff = et_midnight_utc_ms(session_date) + open_ms
    df = pd.read_parquet(path, columns=['strike', 'record_ts'], filters=[('record_ts', '<=', cutoff)])
    return sorted(df['strike'].unique().tolist())


def underlying_series(root: str, session_date: date, expiry: date, open_ms: int, close_ms: int):
    """(t_grid, price, source) on a 1s grid, as-of. Stock roots use the
    quote_1s NBBO mid; SPXW (no stock tape) — or a stock root missing its
    quote_1s file — uses trade_greeks.underlying_price."""
    grid = np.arange(open_ms, close_ms + 1, 1000, dtype='int64')
    qpath = stock_quote_path(root, session_date) if root in config.STOCK_ROOTS else None
    if qpath is not None and qpath.exists():
        q = pd.read_parquet(qpath, columns=['timestamp', 'bid', 'ask'])
        q = q[(q['bid'] > 0) & (q['ask'] > 0) & (q['ask'] >= q['bid'])]
        t = naive_et_to_session_ms(q['timestamp'], session_date)
        order = np.argsort(t, kind='stable')
        t, px = t[order], ((q['bid'].to_numpy() + q['ask'].to_numpy()) / 2)[order]
        source = f'stock quote_1s mid ({qpath.name})'
    else:
        gpath = option_path('trade_greeks', root, expiry)
        if not gpath.exists():
            raise NoData(f'no underlying source for {root} {session_date} (no quote_1s, no {gpath.name})')
        base = et_midnight_utc_ms(session_date)
        g = pd.read_parquet(gpath, columns=['record_ts', 'sequence', 'symbol', 'underlying_price'],
                            filters=[('record_ts', '>=', base + open_ms), ('record_ts', '<=', base + close_ms)])
        g = g[g['underlying_price'] > 0]
        g = sort_ticks(g)
        t = utc_ms_to_session_ms(g['record_ts'].to_numpy(), session_date)
        px = g['underlying_price'].to_numpy()
        source = f'trade_greeks.underlying_price ({gpath.name})'
    keep = (t >= open_ms) & (t <= close_ms)
    t, px = t[keep], px[keep]
    if len(t) == 0:
        raise NoData(f'no underlying prices for {root} on {session_date}')
    gt, gp = as_of_grid(t, px, grid)
    return gt, gp, source


def chart_bars(sym: str, session_date: date, open_ms: int, close_ms: int):
    """1-second OHLCV bars of the chart symbol from the per-trade stock tape.

    Each bar is stamped t = second_start + 999: it becomes visible only once its
    second is over (stale < 1s, never early). Trades through the close second
    are kept; downstream bucketing folds them into the last bar.

    Trade conditions (config): o/h/l/c use LAST_SALE_CONDITIONS only, so
    average-price / late / odd-lot prints can't paint false wicks; a second
    with volume but no eligible print is a flat bar at the previous close.
    `v` counts every trade. VWAP inputs use VWAP_CONDITIONS: `vv` (volume) and
    sums centred on `ref` for numeric stability, so the client computes exact
    trade-level  vwap = ref + Σpv/Σvv,  σ² = Σp2v/Σvv − (Σpv/Σvv)².
    """
    path = stock_trade_path(sym, session_date)
    if not path.exists():
        raise NoData(f'no {sym} trade tape for {session_date} ({path.name})')
    df = pd.read_parquet(path, columns=['trade_timestamp', 'sequence', 'price', 'size', 'condition'])
    df['t'] = naive_et_to_session_ms(df['trade_timestamp'], session_date)
    df = df[(df['t'] >= open_ms) & (df['t'] < close_ms + 1000) & (df['price'] > 0) & (df['size'] > 0)]
    df = df.assign(_seq=seq_key(df['sequence'])).sort_values(['t', '_seq'], kind='stable')
    last_sale = df['condition'].isin(config.LAST_SALE_CONDITIONS)
    if not last_sale.any():
        raise NoData(f'no {sym} trades in RTH on {session_date}')
    ref = float(df.loc[last_sale, 'price'].iat[0])
    d = df['price'] - ref
    vv = df['size'].where(df['condition'].isin(config.VWAP_CONDITIONS), 0)
    df = df.assign(sec=df['t'] // 1000, vv=vv, pv=vv * d, p2v=vv * d * d)

    secs = df.groupby('sec', sort=True).agg(v=('size', 'sum'), vv=('vv', 'sum'), pv=('pv', 'sum'), p2v=('p2v', 'sum'))
    g = df[last_sale].groupby('sec', sort=True)['price']
    secs = secs.join(pd.DataFrame({'o': g.first(), 'h': g.max(), 'l': g.min(), 'c': g.last()}))
    secs['c'] = secs['c'].ffill()                       # volume-only second: flat at prior close
    for col in ('o', 'h', 'l'):
        secs[col] = secs[col].fillna(secs['c'])
    secs = secs.dropna(subset=['c'])                     # nothing eligible yet at the very open

    out = {'symbol': sym, 'ref': ref, 't': (secs.index.to_numpy('int64') * 1000 + 999).tolist()}
    for col in ('o', 'h', 'l', 'c'):
        out[col] = np.round(secs[col].to_numpy(), 4).tolist()
    out['v'] = secs['v'].astype('int64').tolist()
    out['vv'] = secs['vv'].astype('int64').tolist()
    out['pv'] = np.round(secs['pv'].to_numpy(), 3).tolist()
    out['p2v'] = np.round(secs['p2v'].to_numpy(), 4).tolist()
    return out


# ------------------------------------------------------------------ slice

def _validate(session_date: date, root: str, dte: int):
    if root not in config.ROOTS:
        raise NoData(f'root must be one of {", ".join(config.ROOTS)} (got {root})')
    if dte not in (0, 1, 2):
        raise NoData(f'dte must be 0, 1 or 2 (got {dte})')
    if session_date > config.OPTIONS_LAST:
        raise NoData(f'options archive ends {config.OPTIONS_LAST}; {session_date} is past the horizon')
    if session_date < config.OPTIONS_FIRST:
        raise NoData(f'options archive starts {config.OPTIONS_FIRST}; {session_date} is before it')


def build_slice(session_date: date, root: str, dte: int, cadence: str = '1s',
                window: int = config.STRIKE_WINDOW) -> dict:
    _validate(session_date, root, dte)
    if cadence not in ('1s', 'trade'):
        raise ValueError("cadence must be '1s' or 'trade'")
    expiry = resolve_expiry(session_date, dte)
    if expiry > config.OPTIONS_LAST:
        raise NoData(f'expiry {expiry} is past the options archive horizon ({config.OPTIONS_LAST})')
    open_ms, close_ms = session_bounds(session_date)

    opts = read_option_session(root, expiry, session_date, open_ms, close_ms)
    ut, up, usource = underlying_series(root, session_date, expiry, open_ms, close_ms)
    chart = chart_bars(config.CHART_SYMBOL[root], session_date, open_ms, close_ms)

    ladder = ladder_known_at_open(root, expiry, session_date, open_ms)
    ladder_source = 'known at open'
    if len(ladder) < 3:                     # thin pre-open history: fall back to session strikes
        ladder = sorted(opts['strike'].unique().tolist())
        ladder_source = 'traded in session (thin pre-open history)'
    atm, strikes = strike_window(ladder, float(up[0]), window)

    sel = opts[opts['strike'].isin(strikes)]
    contracts = {}
    for sym, g in sel.groupby('symbol', sort=True):
        t = g['t'].to_numpy()
        if cadence == '1s':
            keep = last_per_second(t)
            g, t = g[keep], t[keep]
        keep = changed_rows(g['bid'].to_numpy(), g['ask'].to_numpy(), g['mid_price'].to_numpy())
        g, t = g[keep], t[keep]
        contracts[sym] = {
            'strike': float(g['strike'].iat[0]),
            'type': str(g['contract_type'].iat[0]),
            't': t.tolist(),
            'bid': np.round(g['bid'].to_numpy(), 4).tolist(),
            'ask': np.round(g['ask'].to_numpy(), 4).tolist(),
            'mid': np.round(g['mid_price'].to_numpy(), 4).tolist(),
        }

    return {
        'meta': {
            'slicer_version': SLICER_VERSION,
            'session_date': session_date.isoformat(),
            'root': root,
            'dte': dte,
            'expiry': expiry.isoformat(),
            'time_axis': 'ms since ET midnight of session_date',
            'open_ms': open_ms,
            'close_ms': close_ms,
            'cadence': cadence,
            'strike_window': window,
            'atm_strike_at_open': atm,
            'underlying_at_open': float(up[0]),
            'strikes': strikes,
            'ladder_source': ladder_source,
            'underlying_source': usource,
            'chart_symbol': chart['symbol'],
            'vp_row_size': config.vp_row_size(chart['symbol']),
            'option_rows_session': int(len(opts)),
            'option_rows_emitted': int(sum(len(c['t']) for c in contracts.values())),
        },
        'underlying': {'t': ut.tolist(), 'p': np.round(up, 4).tolist()},
        'chart': chart,
        'contracts': contracts,
    }


def cache_path(session_date: date, root: str, dte: int, cadence: str, window: int) -> Path:
    return config.CACHE_DIR / f'{root}_{session_date.isoformat()}_{dte}dte_{cadence}_w{window}_v{SLICER_VERSION}.json'


def prune_cache() -> int:
    """Delete cached slices/history built by older code versions (cache/ only)."""
    import re
    from .history import HISTORY_VERSION
    slice_re = re.compile(r'^[A-Z]+_\d{4}-\d{2}-\d{2}_\ddte_.*_v(\d+)\.json$')
    hist_re = re.compile(r'^hist_.*_v(\d+)_(\d+)\.json$')
    n = 0
    if config.CACHE_DIR.exists():
        for p in config.CACHE_DIR.glob('*.json'):
            m, h = slice_re.match(p.name), hist_re.match(p.name)
            if (m and int(m.group(1)) != SLICER_VERSION) or                     (h and (int(h.group(1)), int(h.group(2))) != (HISTORY_VERSION, SLICER_VERSION)):
                p.unlink()
                n += 1
    return n


def get_slice_json(session_date: date, root: str, dte: int, cadence: str = '1s',
                   window: int = config.STRIKE_WINDOW, use_cache: bool = True) -> str:
    """Slice as a JSON string, via the project-local cache (never writes to T:)."""
    path = cache_path(session_date, root, dte, cadence, window)
    if use_cache and path.exists():
        return path.read_text(encoding='utf-8')
    text = json.dumps(build_slice(session_date, root, dte, cadence, window), separators=(',', ':'))
    if use_cache:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix('.tmp')
        tmp.write_text(text, encoding='utf-8')
        tmp.replace(path)
    return text


# ------------------------------------------------------------------ CLI

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='Slice one replay session to compact JSON.')
    ap.add_argument('date', type=date.fromisoformat, help='session date (ET), YYYY-MM-DD')
    ap.add_argument('root', type=str.upper, help='SPY | QQQ | SPXW | IWM')
    ap.add_argument('dte', type=int, help='0, 1 or 2')
    ap.add_argument('--cadence', choices=['1s', 'trade'], default='1s',
                    help='option readout: last row per second (default) or every trade')
    ap.add_argument('--window', type=int, default=config.STRIKE_WINDOW, help='strikes each side of ATM')
    ap.add_argument('--out', type=Path, help='write JSON here (default: stdout)')
    ap.add_argument('--no-cache', action='store_true', help='bypass the project cache/')
    a = ap.parse_args(argv)
    try:
        text = get_slice_json(a.date, a.root, a.dte, a.cadence, a.window, use_cache=not a.no_cache)
    except NoData as e:
        print(f'no data: {e}', file=sys.stderr)
        return 2
    m = json.loads(text)['meta']
    print(f"{m['root']} {m['session_date']} {m['dte']}DTE -> expiry {m['expiry']}  "
          f"{fmt_ms(m['open_ms'])}-{fmt_ms(m['close_ms'])} ET  ATM {m['atm_strike_at_open']:g} "
          f"(underlying {m['underlying_at_open']:g}, {m['underlying_source']})  "
          f"{len(m['strikes'])} strikes  rows {m['option_rows_session']:,} -> {m['option_rows_emitted']:,}  "
          f"{len(text) / 1e6:.2f} MB", file=sys.stderr)
    if a.out:
        a.out.write_text(text, encoding='utf-8')
    else:
        sys.stdout.write(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
