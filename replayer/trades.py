"""Trades: exact mark pricing, the practice journal, and broker / uploaded trade overlays.

- quote_at: the option's bid/ask/mid as of a session instant, from the FULL tick tape (the
  browser's 1s slice can be up to <1s stale; marks are re-priced here to the exact row).
- Journal: one JSON object per closed practice round trip in journal/trades.jsonl (private,
  git-ignored). P&L is recomputed here: (exit_bid − entry_mid) × 100 × qty.
- Overlays: fills (the companion repo's order_history.json, read-only, or an uploaded file in
  the same shape) are paired into flat-to-flat round trips per symbol, FIFO, over the whole
  history so positions opened on an earlier day close correctly.
"""
import json
import math
import threading
import uuid
from collections import OrderedDict
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from . import config, slicer
from .slicer import NoData

ET = ZoneInfo('America/New_York')

# ------------------------------------------------------------------ exact mark pricing

_ticks = OrderedDict()                 # (root, expiry, session, osi) -> (t, bid, ask, mid)
_ticks_lock = threading.Lock()
_TICKS_MAX = 24


def contract_ticks(root: str, expiry: date, session_date: date, osi: str):
    key = (root, expiry, session_date, osi)
    with _ticks_lock:
        if key in _ticks:
            _ticks.move_to_end(key)
            return _ticks[key]
    open_ms, close_ms = slicer.session_bounds(session_date)
    path = slicer.option_path('tick', root, expiry)
    if not path.exists():
        raise NoData(f'no {root} tick file for expiry {expiry}')
    base = slicer.et_midnight_utc_ms(session_date)
    df = pd.read_parquet(path, columns=['record_ts', 'sequence', 'symbol', 'bid', 'ask', 'mid_price'],
                         filters=[('symbol', '==', osi), ('record_ts', '>=', base + open_ms),
                                  ('record_ts', '<=', base + close_ms)])
    df = slicer.sort_ticks(df.dropna(subset=['bid', 'ask', 'mid_price']))
    t = slicer.utc_ms_to_session_ms(df['record_ts'].to_numpy(), session_date)
    val = (t, df['bid'].to_numpy(), df['ask'].to_numpy(), df['mid_price'].to_numpy())
    with _ticks_lock:
        _ticks[key] = val
        while len(_ticks) > _TICKS_MAX:
            _ticks.popitem(last=False)
    return val


def quote_at(session_date: date, root: str, dte: int, osi: str, at: int) -> dict:
    """Last tick row with t <= at (no look-ahead), exact to the millisecond."""
    expiry = slicer.resolve_expiry(session_date, dte)
    if not osi.startswith(f'{root:<6}{expiry:%y%m%d}'):
        raise ValueError(f'{osi!r} is not a {root} {expiry} contract')
    t, bid, ask, mid = contract_ticks(root, expiry, session_date, osi)
    i = int(slicer.as_of_index(t, at))
    if i < 0:
        raise NoData(f'no quote for {osi.strip()} at or before {slicer.fmt_ms(at)}')
    return {'osi': osi, 't': int(t[i]), 'bid': float(bid[i]), 'ask': float(ask[i]), 'mid': float(mid[i])}


# ------------------------------------------------------------------ practice journal

_journal_lock = threading.Lock()
JOURNAL_FIELDS = ('session_date', 'root', 'dte', 'expiry', 'osi', 'strike', 'type', 'qty',
                  'entry_t', 'entry_mid', 'exit_t', 'exit_bid')


def journal_read(session_date: str = None, root: str = None) -> list:
    path = config.JOURNAL_PATH
    if not path.exists():
        return []
    out = []
    with _journal_lock:
        for line in path.read_text(encoding='utf-8').splitlines():
            if not line.strip():
                continue
            rec = json.loads(line)
            if session_date and rec.get('session_date') != session_date:
                continue
            if root and rec.get('root') != root:
                continue
            out.append(rec)
    return out


def journal_append(rec: dict) -> dict:
    missing = [f for f in JOURNAL_FIELDS if rec.get(f) is None]
    if missing:
        raise ValueError(f'journal record missing {missing}')
    if rec['type'] not in ('C', 'P'):
        raise ValueError('type must be C or P')
    qty = int(rec['qty'])
    if qty < 1:
        raise ValueError('qty must be >= 1')
    fills = rec.get('fills') or None
    if fills is not None:                                        # scaled in: fills are the truth
        fills = [{'t': math.floor(float(f['t'])), 'mid': round(float(f['mid']), 4), 'qty': int(f['qty'])}
                 for f in fills]
        if any(f['qty'] < 1 for f in fills):
            raise ValueError('fill qty must be >= 1')
        fills.sort(key=lambda f: f['t'])
        qty = sum(f['qty'] for f in fills)
        rec = {**rec, 'qty': qty, 'entry_t': fills[0]['t'],
               'entry_mid': sum(f['mid'] * f['qty'] for f in fills) / qty}
        if len(fills) == 1:
            fills = None                                         # plain trade: keep the old shape
    if int(rec['exit_t']) < int(rec['entry_t']) or (fills and int(rec['exit_t']) < fills[-1]['t']):
        raise ValueError('exit before entry')
    clean = {f: rec[f] for f in JOURNAL_FIELDS}
    clean.update({
        'id': rec.get('id') or uuid.uuid4().hex[:12],
        'source': 'practice',
        'side': 'long_call' if rec['type'] == 'C' else 'long_put',
        'qty': qty,
        'entry_mid': round(float(rec['entry_mid']), 4), 'exit_bid': round(float(rec['exit_bid']), 4),
        'entry_t': math.floor(float(rec['entry_t'])), 'exit_t': math.floor(float(rec['exit_t'])),
        'pnl': round((float(rec['exit_bid']) - float(rec['entry_mid'])) * 100 * qty, 2),
        'offset': rec.get('offset'), 'mfe': rec.get('mfe'), 'mae': rec.get('mae'),
        'note': rec.get('note', ''), 'tag': rec.get('tag', ''),
        **({'fills': fills} if fills else {}),
        'created_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    })
    path = config.JOURNAL_PATH
    with _journal_lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('a', encoding='utf-8') as f:
            f.write(json.dumps(clean) + '\n')
    return clean


def journal_reset(session_date: str, root: str) -> int:
    """Delete every practice trade of one session (date + root). Returns how many."""
    path = config.JOURNAL_PATH
    if not path.exists():
        return 0
    with _journal_lock:
        lines = [ln for ln in path.read_text(encoding='utf-8').splitlines() if ln.strip()]
        keep = [ln for ln in lines if not ((r := json.loads(ln)).get('session_date') == session_date
                                           and r.get('root') == root)]
        if len(keep) != len(lines):
            tmp = path.with_suffix('.tmp')
            tmp.write_text(''.join(ln + '\n' for ln in keep), encoding='utf-8')
            tmp.replace(path)
    return len(lines) - len(keep)


def journal_delete(trade_id: str) -> bool:
    path = config.JOURNAL_PATH
    if not path.exists():
        return False
    with _journal_lock:
        lines = path.read_text(encoding='utf-8').splitlines()
        keep = [ln for ln in lines if ln.strip() and json.loads(ln).get('id') != trade_id]
        if len(keep) == len([ln for ln in lines if ln.strip()]):
            return False
        tmp = path.with_suffix('.tmp')
        tmp.write_text(''.join(ln + '\n' for ln in keep), encoding='utf-8')
        tmp.replace(path)
    return True


# ------------------------------------------------------------------ overlays (fills -> round trips)

def parse_osi(sym: str):
    """'SPXW  261021C07745000' -> (root, expiry, 'C', 7745.0); None if not an OSI option."""
    s = sym.replace(' ', '')
    if len(s) < 16 or s[-9] not in 'CP' or not s[-8:].isdigit() or not s[-15:-9].isdigit():
        return None
    root = s[:-15]
    exp = datetime.strptime(s[-15:-9], '%y%m%d').date()
    return root, exp, s[-9], int(s[-8:]) / 1000


def _to_et(ts: str) -> datetime:
    d = datetime.fromisoformat(ts.replace('Z', '+00:00'))
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(ET)


def _session_ms(et: datetime) -> int:
    return ((et.hour * 60 + et.minute) * 60 + et.second) * 1000 + et.microsecond // 1000


def round_trips(fills: list, day: date, source: str) -> list:
    """Flat-to-flat round trips per symbol (FIFO over all fills) touching `day` (ET)."""
    rows = []
    for f in fills:
        if f.get('is_expiration') and f.get('position_effect') == 'OPENING':
            continue                                  # broker bookkeeping leg of an expiry
        amt = float(f.get('amount') or 0)
        if not amt or not f.get('time') or not f.get('symbol'):
            continue
        rows.append((_to_et(f['time']), f['symbol'], amt, float(f.get('price') or 0),
                     float(f.get('net_cash') or 0), float(f.get('fee') or 0),
                     float(f.get('mult') or 1), f.get('asset_type', '')))
    rows.sort(key=lambda r: r[0])

    trips, open_trip, pos = [], {}, {}
    for et, sym, amt, px, cash, fee, mult, asset in rows:
        p0 = pos.get(sym, 0.0)
        if p0 == 0:
            open_trip[sym] = {'entries': [], 'exits': [], 'cash': 0.0, 'fees': 0.0, 'mult': mult,
                              'asset': asset, 'dir': 1 if amt > 0 else -1}
        tr = open_trip[sym]
        (tr['entries'] if amt * tr['dir'] > 0 else tr['exits']).append((et, abs(amt), px))
        tr['cash'] += cash
        tr['fees'] += fee
        p1 = p0 + amt
        pos[sym] = 0.0 if abs(p1) < 1e-9 else p1
        if pos[sym] == 0:
            trips.append((sym, open_trip.pop(sym)))
    for sym, tr in open_trip.items():                 # still open at the end of the file
        trips.append((sym, tr))

    out = []
    for sym, tr in trips:
        if not tr['entries']:
            continue
        e0, x1 = tr['entries'][0][0], (tr['exits'][-1][0] if tr['exits'] else None)
        if e0.date() != day and (x1 is None or x1.date() != day):
            continue
        vwap = lambda legs: sum(q * p for _, q, p in legs) / sum(q for _, q, _ in legs)
        osi = parse_osi(sym)
        closed = bool(tr['exits']) and abs(sum(q for _, q, _ in tr['entries']) - sum(q for _, q, _ in tr['exits'])) < 1e-9
        long_ = tr['dir'] > 0
        side = (('long_' if long_ else 'short_') + ('call' if osi[2] == 'C' else 'put')) if osi else ('buy' if long_ else 'short')
        out.append({
            'id': f'{source}:{sym.replace(" ", "")}:{e0.isoformat()}',
            'source': source, 'symbol': sym.strip(), 'asset_type': tr['asset'],
            'root': osi[0] if osi else sym.strip(), 'expiry': osi[1].isoformat() if osi else None,
            'type': osi[2] if osi else None, 'strike': osi[3] if osi else None,
            'side': side, 'qty': sum(q for _, q, _ in tr['entries']),
            'entry_ts': e0.isoformat(), 'entry_t': _session_ms(e0) if e0.date() == day else None,
            'entry_price': round(vwap(tr['entries']), 4),
            'exit_ts': x1.isoformat() if x1 else None,
            'exit_t': _session_ms(x1) if x1 and x1.date() == day else None,
            'exit_price': round(vwap(tr['exits']), 4) if tr['exits'] else None,
            'pnl': round(tr['cash'], 2) if closed else None, 'fees': round(tr['fees'], 2),
        })
    out.sort(key=lambda r: r['entry_ts'])
    return out


def _fills_of(obj):
    if isinstance(obj, dict) and 'fills' in obj:
        f = obj['fills']
        return list(f.values()) if isinstance(f, dict) else list(f)
    if isinstance(obj, list) and obj and isinstance(obj[0], dict) and 'amount' in obj[0]:
        return obj
    return None


def broker_trades(day: date) -> list:
    path = config.ORDER_HISTORY
    if not path.exists():
        raise NoData(f'order history not found ({path})')
    with path.open(encoding='utf-8') as f:            # read-only
        return round_trips(_fills_of(json.load(f)) or [], day, 'broker')


def parse_upload(obj, day: date, name: str) -> list:
    """Uploaded JSON: order_history-shaped fills, or this tool's practice export."""
    source = f'upload:{name}'
    fills = _fills_of(obj)
    if fills is not None:
        return round_trips(fills, day, source)
    if isinstance(obj, list) and all(isinstance(r, dict) and 'entry_t' in r for r in obj):
        out = []
        for r in obj:
            if r.get('session_date') not in (None, day.isoformat()):
                continue
            out.append({**r, 'source': source, 'id': f"{source}:{r.get('id', len(out))}",
                        'symbol': r.get('symbol') or (r.get('osi') or '').strip(),
                        'entry_price': r.get('entry_price', r.get('entry_mid')),
                        'exit_price': r.get('exit_price', r.get('exit_bid'))})
        return out
    raise ValueError('unrecognised trade file: expected order_history-style {"fills": ...} '
                     'or a DataReplayer practice export')
