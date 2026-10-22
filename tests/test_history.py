"""Prior-day history (1m context bars, per-day VWAP / profile) — offline."""
import gzip
import json
import threading
import urllib.request
from datetime import date

from fixtures import OPEN_MS, PRIOR, SESSION, FakeArchive
from replayer import history, server


def test_prior_days_are_trading_days_before_session_with_tape():
    with FakeArchive():
        assert history.prior_days('SPY', SESSION, 5) == [PRIOR]       # only PRIOR has a tape
        assert history.prior_days('SPY', PRIOR, 5) == []
        assert history.prior_days('SPY', SESSION, 0) == []


def test_day_summary_minutes_vwap_and_profile():
    with FakeArchive():
        d = history.day_summary('SPY', PRIOR)
    assert d['t'] == [OPEN_MS, OPEN_MS + 60000, OPEN_MS + 120000]
    assert d['o'] == [498.0, 499.0, 500.0] and d['c'] == [498.02, 499.02, 500.02]
    assert min(d['l']) == 498.0                                   # 480 avg-price print paints nothing
    assert d['v'] == [200, 5600, 200]                             # ...but counts in volume
    # session VWAP at the end of minute 2 (regular prints only)
    num = 100 * 498 + 100 * 498.02 + 300 * 499 + 300 * 499.02
    assert abs(d['vwap'][1] - num / 800) < 1e-6
    prof = d['profile']
    assert sum(u + dn for _, u, dn in prof['rows']) == 1000       # VWAP-eligible volume only
    va_lo, va_hi = prof['va']
    assert va_lo <= prof['poc'] <= va_hi and abs(prof['poc'] - 499.0) < 1e-9
    in_va = sum(u + dn for px, u, dn in prof['rows'] if va_lo - 1e-9 <= px <= va_hi + 1e-9)
    assert in_va >= 0.7 * 1000
    assert d['poc'][-1] == prof['poc'] and d['vah'][-1] == va_hi and d['val'][-1] == va_lo


def test_history_endpoint_and_cache():
    with FakeArchive():
        srv = server.make_server(port=0)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            url = f'http://127.0.0.1:{srv.server_address[1]}/api/history?date={SESSION}&root=SPXW&days=5'
            req = urllib.request.Request(url, headers={'Accept-Encoding': 'gzip'})
            with urllib.request.urlopen(req, timeout=30) as r:
                body = json.loads(gzip.decompress(r.read()))
            assert body['symbol'] == 'SPY' and [x['date'] for x in body['days']] == [PRIOR.isoformat()]
            assert history.cache_path('SPY', PRIOR).exists()          # one cache file per day
        finally:
            srv.shutdown()


def test_daily_bars_strictly_before_session():
    import pandas as pd
    from replayer import config
    with FakeArchive():
        d = config.THETA_STOCK / 'stock_eod' / 'SPY'
        d.mkdir(parents=True)
        days = pd.to_datetime(['2026-08-26 17:15', f'{PRIOR} 17:15', f'{SESSION} 17:15', '2026-08-31 17:15'])
        pd.DataFrame({'created': days, 'open': [1.0, 2, 3, 4], 'high': [1.0, 2, 3, 4], 'low': [1.0, 2, 3, 4],
                      'close': [10.0, 20.0, 30.0, 40.0], 'volume': [1, 1, 1, 1]}).to_parquet(d / 'eod_SPY_2026.parquet')
        out = history.daily_bars('SPXW', SESSION, 100)
    assert out['symbol'] == 'SPY'
    assert [x['date'] for x in out['days']] == ['2026-08-26', str(PRIOR)]      # never the session or later
    assert out['days'][-1]['c'] == 20.0
