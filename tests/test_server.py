"""Offline server + sessions tests (fake archive, ephemeral localhost port)."""
import gzip
import json
import threading
import urllib.error
import urllib.request
from datetime import date

from fixtures import SESSION, FakeArchive
from replayer import server, sessions


def test_sessions_for_maps_expiry_back_dte_trading_days():
    exp = ['2026-07-02', '2026-07-06', '2026-08-28']
    assert sessions.sessions_for('SPY', 0, exp) == exp
    # 07-06 (Mon) 1DTE -> 07-02 (Thu): Fri 07-03 is the observed July 4th holiday.
    assert sessions.sessions_for('SPY', 1, exp) == ['2026-07-01', '2026-07-02', '2026-08-27']
    assert sessions.sessions_for('SPY', 0, []) == []


def test_scan_expiries_reads_layout():
    with FakeArchive():
        found = sessions.scan_expiries()
    assert found['SPXW'] == [SESSION.isoformat()] and found['SPY'] == [SESSION.isoformat()]
    assert found['QQQ'] == []


def _serve():
    srv = server.make_server(port=0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f'http://127.0.0.1:{srv.server_address[1]}'


def _get(url, gz=False):
    req = urllib.request.Request(url, headers={'Accept-Encoding': 'gzip'} if gz else {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def test_http_endpoints():
    with FakeArchive():
        sessions._expiries = None
        server._gz_cache.clear()
        srv, base = _serve()
        try:
            code, _, body = _get(f'{base}/api/sessions?root=SPXW&dte=0')
            assert code == 200 and json.loads(body)['sessions'] == [SESSION.isoformat()]

            code, hdr, body = _get(f'{base}/api/slice?date={SESSION}&root=SPXW&dte=0', gz=True)
            assert code == 200 and hdr.get('Content-Encoding') == 'gzip'
            assert json.loads(gzip.decompress(body))['meta']['root'] == 'SPXW'

            code, hdr, body = _get(f'{base}/api/slice?date={SESSION}&root=SPY&dte=0')
            assert code == 200 and 'Content-Encoding' not in hdr and json.loads(body)['meta']['root'] == 'SPY'

            code, _, body = _get(f'{base}/api/slice?date=2026-09-01&root=SPXW&dte=0')
            assert code == 404 and 'horizon' in json.loads(body)['error']

            code, _, _ = _get(f'{base}/api/slice?date=nope&root=SPXW&dte=0')
            assert code == 400

            code, hdr, _ = _get(f'{base}/engine.js')
            assert code == 200 and hdr['Content-Type'].startswith('text/javascript')

            code, _, _ = _get(f'{base}/../replayer/config.py')
            assert code == 404                         # no traversal outside web/
        finally:
            srv.shutdown()
            sessions._expiries = None
            server._gz_cache.clear()
