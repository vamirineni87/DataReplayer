"""Local replay server (stdlib http.server; localhost by default).

    python -m replayer.server [--port 8765] [--host 0.0.0.0]   ->  http://127.0.0.1:8765/

`--host 0.0.0.0` serves the LAN. There is no authentication: anyone on the network can then
read the journal and broker trades and add / delete practice trades.

Routes:
    GET /                       web/index.html
    GET /<file>                 static files under web/
    GET /api/sessions?root=&dte=        available session dates
    GET /api/slice?date=&root=&dte=&cadence=   session slice JSON (gzip if accepted)
    GET /api/history?date=&root=&days=  prior sessions at 1m (VWAP/σ, VP) for chart context
    GET /api/daily?date=&root=&days=    prior daily bars (strictly before date) for 1D EMA/BB
    GET /api/quote?date=&root=&dte=&osi=&t=     exact bid/ask/mid as of t (full tick tape)
    GET/POST/DELETE /api/journal                practice round trips (journal/trades.jsonl);
                                                DELETE ?id= one trade, ?date=&root= reset a session
    PATCH /api/journal?id=                      {note} edit a practice trade's note
    GET/POST /api/watch                         watch log (<journal>_watch.jsonl): spans watched,
                                                jumps, REVIEW, loads, skips; POST {events:[...]}
    PATCH /api/watch?id=                        {note} edit a skip's note
    GET /api/export                             every practice trade + the whole watch log
    GET /api/broker?date=                       real round trips from order_history.json (read-only)
    POST /api/parse-trades?date=&name=          uploaded JSON -> round trips (not stored)
"""
import argparse
import gzip
import json
import math
import mimetypes
import sys
import threading
from collections import OrderedDict
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import config, history, sessions, slicer, trades
from .slicer import NoData

WEB_DIR = (config.PROJECT_DIR / 'web').resolve()

# Windows can map .js to text/plain via the registry; browsers reject that for scripts.
for _ext, _type in (('.js', 'text/javascript'), ('.css', 'text/css'), ('.html', 'text/html'),
                    ('.json', 'application/json'), ('.svg', 'image/svg+xml')):
    mimetypes.add_type(_type, _ext)

_gz_cache = OrderedDict()           # slice key -> gzipped bytes (small LRU)
_gz_lock = threading.Lock()
_GZ_MAX = 6


def _slice_gz(d: date, root: str, dte: int, cadence: str) -> bytes:
    key = (d, root, dte, cadence)
    with _gz_lock:
        if key in _gz_cache:
            _gz_cache.move_to_end(key)
            return _gz_cache[key]
    body = gzip.compress(slicer.get_slice_json(d, root, dte, cadence).encode('utf-8'), 6)
    with _gz_lock:
        _gz_cache[key] = body
        while len(_gz_cache) > _GZ_MAX:
            _gz_cache.popitem(last=False)
    return body


class Handler(BaseHTTPRequestHandler):
    server_version = 'DataReplayer/1'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s %s\n' % (self.log_date_time_string(), fmt % args))

    def _send(self, code: int, body: bytes, ctype: str, gzipped: bool = False):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if gzipped:
            self.send_header('Content-Encoding', 'gzip')
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj).encode('utf-8'), 'application/json')

    MAX_BODY = 32 * 1024 * 1024

    def _body_json(self):
        n = int(self.headers.get('Content-Length') or 0)
        if n <= 0 or n > self.MAX_BODY:
            raise ValueError('missing or oversized body')
        return json.loads(self.rfile.read(n).decode('utf-8'))

    def _dispatch(self, method):
        u = urlparse(self.path)
        q = {k: v[-1] for k, v in parse_qs(u.query).items()}
        try:
            route = self.ROUTES.get((method, u.path))
            if route:
                return route(self, q)
            if method == 'GET':
                return self._static(u.path)
            return self._json(404, {'error': 'not found'})
        except NoData as e:
            return self._json(404, {'error': str(e)})
        except (ValueError, KeyError, json.JSONDecodeError) as e:
            return self._json(400, {'error': f'bad request: {e}'})
        except Exception as e:                        # keep the server alive; surface the error
            return self._json(500, {'error': f'{type(e).__name__}: {e}'})

    def do_GET(self):
        self._dispatch('GET')

    def do_POST(self):
        self._dispatch('POST')

    def do_DELETE(self):
        self._dispatch('DELETE')

    def do_PATCH(self):
        self._dispatch('PATCH')

    def _daily(self, q):
        root = q['root'].upper()
        if root not in config.ROOTS:
            raise NoData(f'root must be one of {", ".join(config.ROOTS)}')
        self._json(200, history.daily_bars(root, date.fromisoformat(q['date']), int(q.get('days', '100'))))

    def _quote(self, q):
        self._json(200, trades.quote_at(date.fromisoformat(q['date']), q['root'].upper(), int(q['dte']),
                                        q['osi'], math.floor(float(q['t']))))

    def _journal_get(self, q):
        self._json(200, {'trades': trades.journal_read(q.get('date'), q.get('root'))})

    def _journal_post(self, q):
        self._json(200, trades.journal_append(self._body_json()))

    def _journal_delete(self, q):
        if 'id' in q:
            return self._json(200, {'deleted': trades.journal_delete(q['id'])})
        date.fromisoformat(q['date'])                            # validate before deleting
        self._json(200, {'deleted': trades.journal_reset(q['date'], q['root'].upper())})

    def _journal_patch(self, q):
        self._json(200, trades.journal_set_note(q['id'], self._body_json().get('note', '')))

    def _watch_get(self, q):
        self._json(200, {'events': trades.watch_read(q.get('date'), q.get('root'))})

    def _watch_post(self, q):
        self._json(200, {'events': trades.watch_append(self._body_json().get('events'))})

    def _watch_patch(self, q):
        self._json(200, trades.watch_set_note(q['id'], self._body_json().get('note', '')))

    def _export(self, q):
        self._json(200, trades.export_all())

    def _broker(self, q):
        self._json(200, {'trades': trades.broker_trades(date.fromisoformat(q['date']))})

    def _parse_trades(self, q):
        self._json(200, {'trades': trades.parse_upload(self._body_json(), date.fromisoformat(q['date']),
                                                       q.get('name', 'upload'))})

    def _sessions(self, q):
        root, dte = q.get('root', 'SPXW').upper(), int(q.get('dte', '0'))
        if root not in config.ROOTS:
            raise NoData(f'root must be one of {", ".join(config.ROOTS)}')
        self._json(200, {'root': root, 'dte': dte, 'last': config.OPTIONS_LAST.isoformat(),
                         'sessions': sessions.sessions_for(root, dte)})

    def _slice(self, q):
        d = date.fromisoformat(q['date'])
        root, dte = q['root'].upper(), int(q['dte'])
        cadence = q.get('cadence', '1s')
        if cadence not in ('1s', 'trade'):
            raise ValueError("cadence must be '1s' or 'trade'")
        body = _slice_gz(d, root, dte, cadence)
        if 'gzip' in self.headers.get('Accept-Encoding', ''):
            self._send(200, body, 'application/json', gzipped=True)
        else:
            self._send(200, gzip.decompress(body), 'application/json')

    def _history(self, q):
        d = date.fromisoformat(q['date'])
        root = q['root'].upper()
        if root not in config.ROOTS:
            raise NoData(f'root must be one of {", ".join(config.ROOTS)}')
        body = gzip.compress(json.dumps(history.history(root, d, int(q.get('days', '5'))),
                                        separators=(',', ':')).encode('utf-8'), 6)
        if 'gzip' in self.headers.get('Accept-Encoding', ''):
            self._send(200, body, 'application/json', gzipped=True)
        else:
            self._send(200, gzip.decompress(body), 'application/json')

    ROUTES = {}

    def _static(self, path: str):
        rel = 'index.html' if path in ('', '/') else path.lstrip('/')
        target = (WEB_DIR / rel).resolve()
        if WEB_DIR not in target.parents or not target.is_file():   # no traversal outside web/
            return self._json(404, {'error': 'not found'})
        ctype = mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype.endswith('javascript'):
            ctype += '; charset=utf-8'
        self._send(200, target.read_bytes(), ctype)


Handler.ROUTES = {
    ('GET', '/api/sessions'): Handler._sessions,
    ('GET', '/api/slice'): Handler._slice,
    ('GET', '/api/history'): Handler._history,
    ('GET', '/api/quote'): Handler._quote,
    ('GET', '/api/daily'): Handler._daily,
    ('GET', '/api/journal'): Handler._journal_get,
    ('POST', '/api/journal'): Handler._journal_post,
    ('DELETE', '/api/journal'): Handler._journal_delete,
    ('PATCH', '/api/journal'): Handler._journal_patch,
    ('GET', '/api/watch'): Handler._watch_get,
    ('POST', '/api/watch'): Handler._watch_post,
    ('PATCH', '/api/watch'): Handler._watch_patch,
    ('GET', '/api/export'): Handler._export,
    ('GET', '/api/broker'): Handler._broker,
    ('POST', '/api/parse-trades'): Handler._parse_trades,
}


def make_server(host: str = '127.0.0.1', port: int = 8765) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), Handler)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='Serve the DataReplayer UI (localhost by default).')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--host', default='127.0.0.1',
                    help="interface to bind; 0.0.0.0 = every interface (LAN access, no auth)")
    a = ap.parse_args(argv)
    pruned = slicer.prune_cache()
    if pruned:
        print(f'pruned {pruned} stale cache file(s)', file=sys.stderr)
    srv = make_server(host=a.host, port=a.port)
    shown = '127.0.0.1' if a.host in ('127.0.0.1', 'localhost') else a.host
    print(f'DataReplayer on http://{shown}:{a.port}/  (Ctrl+C to stop)', file=sys.stderr)
    if a.host not in ('127.0.0.1', 'localhost', '::1'):
        print('WARNING: reachable from other machines; no authentication (journal + broker trades '
              'are readable, practice trades editable)', file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
