"""Local replay server (stdlib http.server; localhost only).

    python -m replayer.server [--port 8765]   ->  http://127.0.0.1:8765/

Routes:
    GET /                       web/index.html
    GET /<file>                 static files under web/
    GET /api/sessions?root=&dte=        available session dates
    GET /api/slice?date=&root=&dte=&cadence=   session slice JSON (gzip if accepted)
"""
import argparse
import gzip
import json
import mimetypes
import sys
import threading
from collections import OrderedDict
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import config, sessions, slicer
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

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[-1] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == '/api/sessions':
                return self._sessions(q)
            if u.path == '/api/slice':
                return self._slice(q)
            return self._static(u.path)
        except NoData as e:
            return self._json(404, {'error': str(e)})
        except (ValueError, KeyError) as e:
            return self._json(400, {'error': f'bad request: {e}'})
        except Exception as e:                        # keep the server alive; surface the error
            return self._json(500, {'error': f'{type(e).__name__}: {e}'})

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

    def _static(self, path: str):
        rel = 'index.html' if path in ('', '/') else path.lstrip('/')
        target = (WEB_DIR / rel).resolve()
        if WEB_DIR not in target.parents or not target.is_file():   # no traversal outside web/
            return self._json(404, {'error': 'not found'})
        ctype = mimetypes.guess_type(target.name)[0] or 'application/octet-stream'
        if ctype.startswith('text/') or ctype.endswith('javascript'):
            ctype += '; charset=utf-8'
        self._send(200, target.read_bytes(), ctype)


def make_server(host: str = '127.0.0.1', port: int = 8765) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), Handler)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description='Serve the DataReplayer UI on localhost.')
    ap.add_argument('--port', type=int, default=8765)
    a = ap.parse_args(argv)
    srv = make_server(port=a.port)
    print(f'DataReplayer on http://127.0.0.1:{a.port}/  (Ctrl+C to stop)', file=sys.stderr)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    sys.exit(main())
