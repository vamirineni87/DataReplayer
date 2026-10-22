"""Practice journal, exact mark pricing, broker / upload round trips — offline."""
import json
import threading
import urllib.request

from fixtures import EXPIRY, OPEN_MS, PRIOR, SESSION, FakeArchive, order_history_fills, osi
from replayer import config, server, trades
from replayer.slicer import NoData


def _raises(exc, fn, *a, **kw):
    try:
        fn(*a, **kw)
    except exc as e:
        return e
    raise AssertionError(f'{exc.__name__} not raised')


def test_round_trips_pairing():
    rt = {r['symbol']: r for r in trades.round_trips(list(order_history_fills().values()), SESSION, 'broker')}
    assert set(rt) == {'SPXW  260828C07750000', 'SPY   260828P00500000', 'SPXW  260828P07700000'}
    a = rt['SPXW  260828C07750000']                       # scale in 2 / out 2
    assert a['side'] == 'long_call' and a['qty'] == 2 and a['entry_price'] == 10.5 and a['exit_price'] == 12.0
    assert a['entry_t'] == 10 * 3600_000 and a['exit_t'] == (10 * 60 + 5) * 60_000
    assert a['pnl'] == round(-1000.65 - 1100.65 + 2398.70, 2) and a['strike'] == 7750.0
    b = rt['SPY   260828P00500000']                       # opened PRIOR, closed SESSION
    assert b['entry_t'] is None and b['entry_ts'].startswith(str(PRIOR)) and b['exit_t'] == (10 * 60 + 30) * 60_000
    assert b['pnl'] == -300.0
    c = rt['SPXW  260828P07700000']                       # expiry closes it; bookkeeping leg ignored
    assert c['qty'] == 1 and c['exit_price'] == 0.0 and c['pnl'] == -150.0


def test_parse_upload_formats():
    fills = {'fills': order_history_fills()}
    assert len(trades.parse_upload(fills, SESSION, 'x.json')) == 3
    assert len(trades.parse_upload({'fills': list(order_history_fills().values())}, SESSION, 'x.json')) == 3
    practice = [{'id': 'p1', 'session_date': str(SESSION), 'osi': osi('SPXW', 'C', 7750), 'type': 'C',
                 'strike': 7750, 'entry_t': OPEN_MS, 'entry_mid': 10.0, 'exit_t': OPEN_MS + 1000,
                 'exit_bid': 11.0, 'pnl': 100.0, 'qty': 1},
                {'id': 'p2', 'session_date': str(PRIOR), 'entry_t': 1}]
    out = trades.parse_upload(practice, SESSION, 'mine.json')
    assert len(out) == 1 and out[0]['entry_price'] == 10.0 and out[0]['source'] == 'upload:mine.json'
    _raises(ValueError, trades.parse_upload, {'nope': 1}, SESSION, 'bad.json')


def test_journal_append_validate_delete():
    with FakeArchive():
        rec = {'session_date': str(SESSION), 'root': 'SPXW', 'dte': 0, 'expiry': str(EXPIRY),
               'osi': osi('SPXW', 'C', 7750), 'strike': 7750, 'type': 'C', 'qty': 2,
               'entry_t': OPEN_MS, 'entry_mid': 10.000000001, 'exit_t': OPEN_MS + 5000, 'exit_bid': 10.6}
        saved = trades.journal_append(rec)
        assert saved['pnl'] == 120.0 and saved['entry_mid'] == 10.0 and saved['side'] == 'long_call'
        assert config.JOURNAL_PATH.exists() and 'T:' not in str(config.JOURNAL_PATH)
        assert [r['id'] for r in trades.journal_read(str(SESSION), 'SPXW')] == [saved['id']]
        assert trades.journal_read(str(PRIOR)) == []
        _raises(ValueError, trades.journal_append, {**rec, 'exit_t': OPEN_MS - 1})      # exit before entry
        _raises(ValueError, trades.journal_append, {**rec, 'type': 'X'})
        assert trades.journal_delete(saved['id']) and trades.journal_read() == []
        assert not trades.journal_delete('missing')


def test_quote_at_is_exact_and_never_early():
    with FakeArchive():
        sym = osi('SPXW', 'C', 7750)
        q = trades.quote_at(SESSION, 'SPXW', 0, sym, 10 * 3600_000)        # 10:00:00.000
        # two rows share that ms (sequence wrap) -> the later one (12.0); the 10:00:02 row is unseen
        assert q['bid'] == 12.0 and q['t'] == 10 * 3600_000
        assert trades.quote_at(SESSION, 'SPXW', 0, sym, 10 * 3600_000 + 1999)['bid'] == 12.0
        _raises(NoData, trades.quote_at, SESSION, 'SPXW', 0, sym, OPEN_MS)   # 09:25 pre-open row excluded
        _raises(ValueError, trades.quote_at, SESSION, 'SPXW', 0, osi('SPY', 'C', 500), OPEN_MS)


def test_trade_routes():
    with FakeArchive():
        srv = server.make_server(port=0)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        base = f'http://127.0.0.1:{srv.server_address[1]}'

        def call(path, method='GET', body=None):
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(base + path, data=data, method=method,
                                         headers={'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read())
        try:
            assert len(call(f'/api/broker?date={SESSION}')['trades']) == 3
            rec = {'session_date': str(SESSION), 'root': 'SPXW', 'dte': 0, 'expiry': str(EXPIRY),
                   'osi': osi('SPXW', 'C', 7750), 'strike': 7750, 'type': 'C', 'qty': 1,
                   'entry_t': OPEN_MS, 'entry_mid': 10.2, 'exit_t': OPEN_MS + 60000, 'exit_bid': 11.0}
            saved = call('/api/journal', 'POST', rec)
            assert call(f'/api/journal?date={SESSION}&root=SPXW')['trades'][0]['id'] == saved['id']
            assert call(f'/api/journal?id={saved["id"]}', 'DELETE')['deleted'] is True
            parsed = call(f'/api/parse-trades?date={SESSION}&name=h.json', 'POST', {'fills': order_history_fills()})
            assert len(parsed['trades']) == 3
            q = call(f'/api/quote?date={SESSION}&root=SPXW&dte=0&osi={urllib.request.quote(osi("SPXW", "C", 7750))}&t={10 * 3600_000}')
            assert q['bid'] == 12.0
            # mid-playback clocks are fractional ms (regression: these used to 400)
            q = call(f'/api/quote?date={SESSION}&root=SPXW&dte=0&osi={urllib.request.quote(osi("SPXW", "C", 7750))}&t={10 * 3600_000 + 0.6}')
            assert q['bid'] == 12.0 and q['t'] == 10 * 3600_000
            saved = call('/api/journal', 'POST', {**rec, 'entry_t': OPEN_MS + 0.6, 'exit_t': OPEN_MS + 60000.4})
            assert saved['entry_t'] == OPEN_MS and saved['exit_t'] == OPEN_MS + 60000
        finally:
            srv.shutdown()
