"""Offline slicer tests (synthetic archive; no T:\\ needed)."""
from datetime import date

import numpy as np
import pandas as pd

from fixtures import CLOSE_MS, EXPIRY, OPEN_MS, SESSION, FakeArchive, osi, spxw_tick_rows, utc_ms
from replayer import config, slicer
from replayer.slicer import NoData


def _raises(exc, fn, *a, **kw):
    try:
        fn(*a, **kw)
    except exc as e:
        return e
    raise AssertionError(f'{exc.__name__} not raised')


# ------------------------------------------------------------------ time

def test_utc_to_session_ms_edt_and_est():
    # 13:30Z in August (EDT) and 14:30Z in January (EST) are both 09:30 ET.
    assert slicer.utc_ms_to_session_ms([utc_ms(SESSION, 9, 30)], SESSION)[0] == OPEN_MS
    jan = date(2026, 1, 15)
    jan_open_utc = int(pd.Timestamp('2026-01-15 14:30', tz='UTC').timestamp() * 1000)
    assert slicer.utc_ms_to_session_ms([jan_open_utc], jan)[0] == OPEN_MS


def test_utc_to_session_ms_other_day_out_of_range():
    t = slicer.utc_ms_to_session_ms([utc_ms(date(2026, 8, 27), 15, 0)], SESSION)[0]
    assert t < 0


def test_naive_et_stock_timestamps_not_shifted():
    t = slicer.naive_et_to_session_ms(pd.to_datetime([f'{SESSION} 09:30:00']), SESSION)[0]
    assert t == OPEN_MS


def test_session_bounds_regular_and_early_close():
    assert slicer.session_bounds(SESSION) == (OPEN_MS, CLOSE_MS)
    o, c = slicer.session_bounds(date(2025, 11, 28))      # day after Thanksgiving: 13:00 close
    assert (o, c) == (OPEN_MS, 13 * 3600_000)


# ------------------------------------------------------------------ expiry

def test_resolve_expiry_same_day_and_holiday():
    assert slicer.resolve_expiry(SESSION, 0) == SESSION
    # Thu 2026-07-02, 1DTE: Fri 07-03 is the observed July 4th holiday -> Mon 07-06.
    assert slicer.resolve_expiry(date(2026, 7, 2), 1) == date(2026, 7, 6)
    _raises(NoData, slicer.resolve_expiry, date(2026, 8, 29), 0)   # Saturday


# ------------------------------------------------------------------ ordering

def test_sort_ticks_sequence_wrap_and_dedup():
    df = spxw_tick_rows()
    df = df[df['symbol'] == osi('SPXW', 'C', 7750)]
    out = slicer.sort_ticks(df)
    ten = out[out['record_ts'] == utc_ms(SESSION, 10, 0)]
    # Wrapped (negative) sequence is the LATER event within the same ms.
    assert ten['sequence'].tolist() == [2147483647, -2147483648]
    ten2 = out[out['record_ts'] == utc_ms(SESSION, 10, 0, 2)]
    # Exact duplicate collapsed; same-ms different-seq row kept (no dedup on record_ts alone).
    assert ten2['sequence'].tolist() == [5, 6]


# ------------------------------------------------------------------ no look-ahead

def test_as_of_boundaries():
    t = np.array([1000, 2000, 3000])
    v = np.array([1.0, 2.0, 3.0])
    assert slicer.price_as_of(t, v, 999) is None
    assert slicer.price_as_of(t, v, 1999) == 1.0          # never the future row
    assert slicer.price_as_of(t, v, 2000) == 2.0          # row at exactly T is visible
    assert slicer.price_as_of(t, v, 10**9) == 3.0


def test_as_of_grid_never_early():
    t = np.array([400, 2100, 5000])
    v = np.array([1.0, 2.0, 3.0])
    gt, gv = slicer.as_of_grid(t, v, np.arange(0, 6000, 1000))
    assert gt.tolist() == [1000, 2000, 3000, 4000, 5000]  # grid 0 precedes first sample
    assert gv.tolist() == [1.0, 1.0, 2.0, 2.0, 3.0]       # 2000 must not see the 2100 row


def test_compression_is_lossless_for_as_of():
    rng = np.random.default_rng(7)
    t = np.sort(rng.integers(0, 60_000, 3000))
    bid = np.round(rng.choice([1.0, 1.05, 1.1], size=len(t)), 2)
    ask = bid + 0.05
    keep = slicer.changed_rows(bid, ask)
    assert keep.sum() < len(t)
    for q in rng.integers(-10, 61_000, 2000):
        assert slicer.price_as_of(t, bid, q) == slicer.price_as_of(t[keep], bid[keep], q)


def test_last_per_second_stale_never_early():
    t = np.array([100, 900, 1500, 1999, 2000, 3500])
    v = np.arange(len(t), dtype=float)
    keep = slicer.last_per_second(t)
    assert t[keep].tolist() == [900, 1999, 2000, 3500]
    for q in range(0, 4000, 7):
        full_i = int(slicer.as_of_index(t, q))
        kept_i = int(slicer.as_of_index(t[keep], q))
        if kept_i >= 0:                                   # downsampled row is never after q
            assert t[keep][kept_i] <= q and t[keep][kept_i] <= t[full_i]
        if q % 1000 == 999:                               # exact at each second's end
            assert v[keep][kept_i] == v[full_i]


# ------------------------------------------------------------------ strikes

def test_strike_window_and_pick_match_live_tool():
    ladder = [float(k) for k in range(100, 201, 5)]
    atm, win = slicer.strike_window(ladder, 152.4, 2)
    assert atm == 150.0 and win == [140.0, 145.0, 150.0, 155.0, 160.0]
    assert slicer.strike_window(ladder, 152.5, 0)[0] == 150.0   # tie -> lower
    assert slicer.pick_strike(win, 150.1, 'C', 0) == 150.0
    assert slicer.pick_strike(win, 150.1, 'C', 1) == 155.0      # +offset = OTM for calls
    assert slicer.pick_strike(win, 150.1, 'P', 1) == 145.0      # +offset = OTM for puts
    assert slicer.pick_strike(win, 150.1, 'C', 9) == 160.0      # clamped to the window


def test_ladder_excludes_strikes_listed_after_open():
    with FakeArchive():
        ladder = slicer.ladder_known_at_open('SPXW', EXPIRY, SESSION, OPEN_MS)
        assert 9000.0 not in ladder and 7750.0 in ladder


# ------------------------------------------------------------------ end to end

def test_build_slice_spxw():
    with FakeArchive() as fa:
        before = fa.snapshot()
        s = slicer.build_slice(SESSION, 'SPXW', 0, cadence='trade', window=2)
        assert fa.snapshot() == before                    # archive untouched
    m = s['meta']
    assert m['expiry'] == '2026-08-28' and m['atm_strike_at_open'] == 7750.0
    assert m['strikes'] == [7740.0, 7745.0, 7750.0, 7755.0, 7760.0]
    assert 'trade_greeks' in m['underlying_source']
    u = s['underlying']
    assert u['t'][0] == OPEN_MS + 1000 and u['p'][0] == 7751.0   # 09:30:00 precedes first sample
    assert u['p'][u['t'].index(OPEN_MS + 2000)] == 7751.0        # 09:30:02.100 not seen at :02
    c = s['contracts'][osi('SPXW', 'C', 7750)]
    assert all(OPEN_MS <= t <= CLOSE_MS for t in c['t'])          # prior day + pre-open dropped
    assert c['bid'][0] == 10.0                                    # pre-open 1.0 row excluded
    assert c['bid'] == [10.0, 11.0, 12.0, 12.5, 13.0]             # wrap order; unchanged 09:30:01.5 dropped
    assert osi('SPXW', 'C', 9000) not in s['contracts']


def test_build_slice_1s_cadence_keeps_last_in_second():
    with FakeArchive():
        s = slicer.build_slice(SESSION, 'SPXW', 0, cadence='1s', window=2)
    c = s['contracts'][osi('SPXW', 'C', 7750)]
    # Last row per second: 09:30:01 -> 10.0 (the .5 repeat), 10:00:00 -> the wrapped
    # seq (12.0, not 11.0), 10:00:02 -> seq 6 (13.0, not 12.5).
    assert c['bid'] == [10.0, 12.0, 13.0]
    assert c['t'] == [OPEN_MS + 1500, 10 * 3600_000, 10 * 3600_000 + 2000]


def test_build_slice_spy_uses_stock_mid():
    with FakeArchive():
        s = slicer.build_slice(SESSION, 'SPY', 0, window=1)
    assert s['underlying']['t'][0] == OPEN_MS
    assert s['underlying']['p'][0] == 500.01
    assert s['meta']['atm_strike_at_open'] == 500.0
    assert 'quote_1s' in s['meta']['underlying_source']


def test_chart_bars_from_trade_tape():
    with FakeArchive():
        c = slicer.chart_bars('SPY', SESSION, OPEN_MS, CLOSE_MS)
    # Bars stamped at second END (visible only once the second is over).
    assert c['t'] == [OPEN_MS + 999, OPEN_MS + 1999, OPEN_MS + 2999, CLOSE_MS - 1000 + 999, CLOSE_MS + 999]
    assert c['o'][:2] == [500.0, 499.9] and c['c'][:2] == [500.1, 499.95]
    assert c['h'][0] == 500.1                                   # 500.80 avg-price print paints no wick
    assert c['l'][1] == 499.9
    assert [c['o'][2], c['h'][2], c['l'][2], c['c'][2]] == [499.95] * 4   # odd-lot-only second: flat
    assert c['v'] == [153, 300, 2, 10, 1000]                    # all trades; pre-open/post-close dropped
    assert c['vv'] == [150, 300, 2, 10, 1000]                   # VWAP excludes the avg-price print
    assert c['ref'] == 500.0
    # Volume-weighted sums centred on ref reproduce the exact VWAP of the first second.
    assert abs((c['ref'] + c['pv'][0] / c['vv'][0]) - (500.0 * 100 + 500.1 * 50) / 150) < 1e-9


def test_chart_bars_trade_counts_and_subsecond_snapshots():
    with FakeArchive():
        c = slicer.chart_bars('SPY', SESSION, OPEN_MS, CLOSE_MS)
    assert c['n'] == [3, 2, 1, 1, 1]                            # every trade counts toward tape speed
    s = c['sub']
    # 09:30:00 q0 (100 @500), q2 adds the avg-price print's volume (state changed) — q3 omitted (=1s bar);
    # 09:30:01 q0 both prints; 09:30:02 odd-lot only -> no eligible price -> no snapshot.
    assert s['t'] == [OPEN_MS + 249, OPEN_MS + 749, OPEN_MS + 1249, CLOSE_MS - 251, CLOSE_MS + 249]
    assert [s['o'][0], s['h'][0], s['l'][0], s['c'][0], s['v'][0], s['n'][0]] == [500.0, 500.0, 500.0, 500.0, 100, 1]
    assert s['c'][1] == 500.0 and s['h'][1] == 500.0 and s['v'][1] == 103 and s['n'][1] == 2   # 500.80 print: no wick
    assert [s['o'][2], s['h'][2], s['l'][2], s['c'][2], s['v'][2]] == [499.9, 499.95, 499.9, 499.95, 300]
    for t in s['t']:                                             # each snapshot precedes its second's 1s bar
        assert (t // 1000) * 1000 + 999 in c['t'] and t % 1000 != 999


def test_spxw_slice_charts_spy():
    with FakeArchive():
        s = slicer.build_slice(SESSION, 'SPXW', 0, window=2)
    assert s['meta']['chart_symbol'] == 'SPY' and s['chart']['symbol'] == 'SPY'
    assert 'trade_greeks' in s['meta']['underlying_source']     # strikes still follow SPX


def test_no_data_cases():
    with FakeArchive():
        e = _raises(NoData, slicer.build_slice, date(2026, 8, 31), 'SPXW', 0)
        assert '2026-08-28' in str(e)                             # tells the user the horizon
        _raises(NoData, slicer.build_slice, date(2026, 8, 27), 'QQQ', 1)   # no expiry file
        _raises(NoData, slicer.build_slice, SESSION, 'SPX', 0)            # unsupported root


def test_cache_written_only_under_project_cache():
    with FakeArchive() as fa:
        before = fa.snapshot()
        a = slicer.get_slice_json(SESSION, 'SPY', 0, window=1)
        path = slicer.cache_path(SESSION, 'SPY', 0, '1s', 1)
        assert path.exists() and path.parent == config.CACHE_DIR
        assert slicer.get_slice_json(SESSION, 'SPY', 0, window=1) == a
        assert fa.snapshot() == before


# ------------------------------------------------------------------ real archive (skipped offline)

def test_real_archive_spxw_0dte_maps_to_rth():
    """SPEC §5 rule 2: real SPXW 0DTE first/last option rows ~09:30 / ~16:00 ET."""
    import unittest
    from pathlib import Path
    real = Path(r'T:\data\ThetaData\parquet')
    if not (real / '2026' / '08' / '2026-08-28' / 'tick_SPXW_2026-08-28.parquet').exists():
        raise unittest.SkipTest('T: archive not mounted')
    saved = config.THETA_PARQUET
    config.THETA_PARQUET = real
    try:
        df = slicer.read_option_session('SPXW', date(2026, 8, 28), date(2026, 8, 28), OPEN_MS, CLOSE_MS)
    finally:
        config.THETA_PARQUET = saved
    assert OPEN_MS <= df['t'].iat[0] < OPEN_MS + 60_000
    assert CLOSE_MS - 60_000 < df['t'].iat[-1] <= CLOSE_MS
