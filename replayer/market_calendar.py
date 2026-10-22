# Copied from Schwab-TradingBotLite/market_calendar.py (do NOT import across repos; see CLAUDE.md).
"""
market_calendar.py - Shared NYSE trading-day helper.

Both bracket scripts need "the next N trading days" to map option
expirations to a DTE offset. Skipping weekends alone is wrong on holiday
weeks (a Monday holiday shifts every DTE label), so this uses the
authoritative NYSE calendar from pandas_market_calendars when available and
falls back to a computed NYSE holiday set otherwise.

Public API:
    next_trading_days(n=3, start=None) -> list[date]
        The next N NYSE trading days, INCLUDING `start` (default today) if it
        is itself a trading day. Ascending.
    is_trading_day(d) -> bool
"""

from datetime import date, datetime, time as dtime, timedelta
from typing import List, Optional, Tuple

try:
    import pandas_market_calendars as _mcal
    _NYSE = _mcal.get_calendar('NYSE')
except Exception:                        # library missing or failed to load
    _NYSE = None

try:
    from zoneinfo import ZoneInfo
    _ET = ZoneInfo('America/New_York')
except Exception:
    _ET = None

# Index options trade 15 minutes past the equity close (e.g. SPX/SPXW to 16:15).
_INDEX_OPTION_ROOTS = {'SPX', 'SPXW', 'NDX', 'NDXP', 'RUT', 'RUTW', 'VIX', 'VIXW', 'XSP'}
_rth_cache: dict = {}                    # (date, is_index) -> (open_dt, close_dt)


# ---------------------------------------------------------------- fallback

def _easter(year: int) -> date:
    """Anonymous Gregorian algorithm - Easter Sunday (for Good Friday)."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """n-th `weekday` (Mon=0) of month; n<0 counts from the end (-1 = last)."""
    if n > 0:
        d = date(year, month, 1)
        offset = (weekday - d.weekday()) % 7
        return d + timedelta(days=offset + 7 * (n - 1))
    d = date(year, month, 28) + timedelta(days=4)     # into next month
    d = d.replace(day=1) - timedelta(days=1)          # last day of month
    offset = (d.weekday() - weekday) % 7
    return d - timedelta(days=offset)


def _observed(d: date) -> date:
    """NYSE weekend-observance: Sat -> prior Fri, Sun -> next Mon."""
    if d.weekday() == 5:
        return d - timedelta(days=1)
    if d.weekday() == 6:
        return d + timedelta(days=1)
    return d


def _us_market_holidays(year: int) -> set:
    """Computed NYSE holiday set for a year (fallback when the library is
    absent). New Year's Day on a Saturday is NOT observed by the NYSE."""
    hols = set()
    nyd = date(year, 1, 1)
    if nyd.weekday() != 5:                            # skip Sat New Year (no makeup)
        hols.add(_observed(nyd))
    hols.add(_nth_weekday(year, 1, 0, 3))             # MLK - 3rd Mon Jan
    hols.add(_nth_weekday(year, 2, 0, 3))             # Presidents - 3rd Mon Feb
    hols.add(_easter(year) - timedelta(days=2))       # Good Friday
    hols.add(_nth_weekday(year, 5, 0, -1))            # Memorial - last Mon May
    if year >= 2022:
        hols.add(_observed(date(year, 6, 19)))        # Juneteenth
    hols.add(_observed(date(year, 7, 4)))             # Independence
    hols.add(_nth_weekday(year, 9, 0, 1))             # Labor - 1st Mon Sep
    hols.add(_nth_weekday(year, 11, 3, 4))            # Thanksgiving - 4th Thu Nov
    hols.add(_observed(date(year, 12, 25)))           # Christmas
    return hols


def _is_trading_day_fallback(d: date) -> bool:
    return d.weekday() < 5 and d not in _us_market_holidays(d.year)


# ------------------------------------------------------------------ public

def is_trading_day(d: date) -> bool:
    if _NYSE is not None:
        sched = _NYSE.valid_days(start_date=d, end_date=d)
        return len(sched) > 0
    return _is_trading_day_fallback(d)


def next_trading_days(n: int = 3, start: Optional[date] = None) -> List[date]:
    """Next N NYSE trading days, including `start` (default today) if it is a
    trading day. Ascending."""
    if start is None:
        start = datetime.now().date()

    if _NYSE is not None:
        # Look far enough ahead to clear any weekend + holiday run.
        sched = _NYSE.valid_days(start_date=start, end_date=start + timedelta(days=n + 21))
        days = [ts.date() for ts in sched][:n]
        if len(days) == n:
            return days
        # Extremely unlikely (huge market closure); widen once.
        sched = _NYSE.valid_days(start_date=start, end_date=start + timedelta(days=n + 90))
        return [ts.date() for ts in sched][:n]

    days, cur = [], start
    while len(days) < n:
        if _is_trading_day_fallback(cur):
            days.append(cur)
        cur += timedelta(days=1)
    return days


def _is_index_root(symbol: Optional[str]) -> bool:
    if not symbol:
        return False
    root = symbol.lstrip('$').split()[0].upper()   # '$SPX'->SPX, 'SPXW  ...'->SPXW
    return root in _INDEX_OPTION_ROOTS


def rth_bounds(d: date, symbol: Optional[str] = None) -> Tuple[Optional[datetime], Optional[datetime]]:
    """(market_open, market_close) as tz-aware ET datetimes for date `d`, or
    (None, None) if `d` is not a trading day. Uses the NYSE schedule (so it
    respects early-close days) when available, else 9:30-16:00 ET. Index
    options get +15 minutes on the close (e.g. SPX to 16:15)."""
    is_index = _is_index_root(symbol)
    key = (d, is_index)
    if key in _rth_cache:
        return _rth_cache[key]
    open_dt = close_dt = None
    if _NYSE is not None and _ET is not None:
        try:
            sched = _NYSE.schedule(start_date=d, end_date=d)
            if not sched.empty:
                open_dt = sched.iloc[0]['market_open'].tz_convert(_ET).to_pydatetime()
                close_dt = sched.iloc[0]['market_close'].tz_convert(_ET).to_pydatetime()
        except Exception:
            open_dt = close_dt = None
    if open_dt is None and _ET is not None and _is_trading_day_fallback(d):
        open_dt = datetime.combine(d, dtime(9, 30), _ET)
        close_dt = datetime.combine(d, dtime(16, 0), _ET)
    if close_dt is not None and is_index:
        close_dt = close_dt + timedelta(minutes=15)
    _rth_cache[key] = (open_dt, close_dt)
    return open_dt, close_dt


def is_rth(symbol: Optional[str] = None, now: Optional[datetime] = None) -> bool:
    """True if the market is open for `symbol` right now (Regular Trading
    Hours). If the timezone can't be determined it returns True (fails open)
    rather than blocking - the broker still rejects a genuinely bad order."""
    if _ET is None:
        return True
    now = now or datetime.now(_ET)
    if now.tzinfo is None:
        now = now.replace(tzinfo=_ET)
    now = now.astimezone(_ET)
    o, c = rth_bounds(now.date(), symbol)
    if o is None:
        return False                     # not a trading day
    return o <= now <= c
