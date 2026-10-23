#!/usr/bin/env python3
"""A minimal remoteStorage server over one directory (Python stdlib only).

It speaks plain remoteStorage (draft-dejong-remotestorage): folder listings,
GET/HEAD/PUT/DELETE of documents, strong ETags and If-Match/If-None-Match.
Files stay plain files, so other programs (an editor, git, panel_agent.py
--no-git) can work on the same directory. There is no WebFinger or OAuth:
tokens are made with --add-token and pasted into the app's keychain.

    python3 rs_server.py --add-token laptop            # prints a token once
    python3 rs_server.py ~/notes                        # http://127.0.0.1:8765/storage/
    python3 rs_server.py ~/notes --bind 192.168.1.10    # https, with its own private CA

By default a page from any origin may call the server (it still needs a
token). --allow-origin https://miuele.github.io (repeatable) restricts it.

On a non-loopback address the server uses HTTPS. Without --cert/--key it
creates a private CA (with `openssl`) that may only vouch for the server's
IP addresses, and prints the path of ca.crt to import on each device.

Known limit: a program that writes the same file in the moment between the
server's version check and its rename is overwritten without a conflict.
"""
import argparse
import email.utils
import hashlib
import http.server
import ipaddress
import json
import mimetypes
import os
import secrets
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

MAX_FILE_SIZE = 100 * 1024 * 1024
TMP_PREFIX = '.rs-tmp-'
UMASK = os.umask(0)
os.umask(UMASK)
TEXT_TYPES = {'.md': 'text/markdown', '.markdown': 'text/markdown', '.json': 'application/json'}


class HttpError(Exception):
    def __init__(self, status, code, message, headers=None):
        super().__init__(message)
        self.status, self.code, self.message, self.headers = status, code, message, headers or {}


# ---------------------------------------------------------------------------
# Versions: the git blob id of a file, and a Merkle hash for folders
# ---------------------------------------------------------------------------

class Versions:
    def __init__(self):
        self._cache = {}   # path -> ((dev, ino, mtime_ns, size), etag)
        self._lock = threading.Lock()

    def file(self, path, st=None):
        st = st or os.stat(path)
        key = (st.st_dev, st.st_ino, st.st_mtime_ns, st.st_size)
        with self._lock:
            hit = self._cache.get(path)
        if hit and hit[0] == key:
            return hit[1]
        h = hashlib.sha1(b'blob %d\0' % st.st_size)
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(1 << 20), b''):
                h.update(chunk)
        etag = h.hexdigest()
        with self._lock:
            self._cache[path] = (key, etag)
        return etag

    def folder(self, items):
        """SHA-1 over sorted `name SP etag LF` lines of the non-empty children."""
        lines = ''.join(f'{name} {item["ETag"]}\n' for name, item in sorted(items.items()))
        return hashlib.sha1(lines.encode()).hexdigest()


# ---------------------------------------------------------------------------
# The store: one root directory
# ---------------------------------------------------------------------------

class Store:
    def __init__(self, root):
        self.root = os.path.realpath(root)
        self.versions = Versions()
        self.write_lock = threading.Lock()

    def resolve(self, segments):
        """Filesystem path for URL segments, refusing anything outside the root."""
        for s in segments:
            if s in ('', '.', '..') or '\0' in s or '\\' in s:
                raise HttpError(400, 'bad_path', 'Malformed path.')
        if segments and segments[0] == '.git':
            raise HttpError(403, 'forbidden', '.git is not served.')
        path = os.path.join(self.root, *segments)
        # Follow symlinks for whatever exists of the path; it must stay under the root.
        probe = path
        while not os.path.lexists(probe) and probe != self.root:
            probe = os.path.dirname(probe)
        real = os.path.realpath(probe)
        if real != self.root and not real.startswith(self.root + os.sep):
            raise HttpError(403, 'forbidden', 'Path leaves the storage root.')
        return path

    def _visible(self, parent, name):
        if name.startswith(TMP_PREFIX) or (parent == self.root and name == '.git'):
            return False
        real = os.path.realpath(os.path.join(parent, name))
        return real == self.root or real.startswith(self.root + os.sep)

    def listing(self, path):
        """remoteStorage items of a folder; empty folders are left out."""
        items = {}
        try:
            entries = list(os.scandir(path))
        except (FileNotFoundError, NotADirectoryError):
            return items
        for e in entries:
            if not self._visible(path, e.name):
                continue
            try:
                if e.is_dir():
                    sub = self.listing(e.path)
                    if sub:
                        items[e.name + '/'] = {'ETag': self.versions.folder(sub)}
                elif e.is_file():
                    st = e.stat()
                    items[e.name] = {
                        'ETag': self.versions.file(e.path, st),
                        'Content-Type': content_type(e.name),
                        'Content-Length': st.st_size,
                        'Last-Modified': email.utils.formatdate(st.st_mtime, usegmt=True),
                    }
            except OSError:
                continue   # vanished while listing
        return items

    def current_etag(self, path):
        if os.path.isdir(path):
            raise HttpError(409, 'type_conflict', 'A folder has this name.')
        return self.versions.file(path) if os.path.isfile(path) else None

    def check_parents(self, segments):
        for i in range(1, len(segments)):
            if os.path.isfile(os.path.join(self.root, *segments[:i])):
                raise HttpError(409, 'type_conflict', 'A path segment is an existing document.')


def content_type(name):
    ext = os.path.splitext(name)[1].lower()
    ctype = TEXT_TYPES.get(ext) or mimetypes.guess_type(name)[0] or 'application/octet-stream'
    return ctype + '; charset=utf-8' if ctype.startswith('text/') else ctype


def check_precondition(headers, current):
    """remoteStorage If-Match / If-None-Match; this server requires one on writes."""
    if_match, if_none = headers.get('If-Match'), headers.get('If-None-Match')
    if if_match is None and if_none is None:
        raise HttpError(428, 'precondition_required', 'Send If-Match or If-None-Match.')
    if if_none is not None and if_none.strip() == '*' and current is not None:
        raise HttpError(412, 'exists', 'The document already exists.', etag_header(current))
    if if_match is not None:
        wanted = {t.strip().removeprefix('W/').strip('"') for t in if_match.split(',')}
        if current is None or ('*' not in wanted and current not in wanted):
            raise HttpError(412, 'version_mismatch', 'The document changed on the server.', etag_header(current))


def etag_header(etag):
    return {'ETag': f'"{etag}"'} if etag else {}


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'gh-memo-rs/1'
    protocol_version = 'HTTP/1.1'

    # -- request plumbing --------------------------------------------------

    def _refusal(self):
        """Why the Host or Origin is refused, or None."""
        host = self.headers.get('Host', '')
        if host.lower() not in self.server.hosts:
            return f'Unknown Host: {host}'
        origin = self.headers.get('Origin')
        if origin is not None and self.server.origins is not None and origin not in self.server.origins:
            return f'Origin not allowed: {origin} (add it with --allow-origin)'
        return None

    def _cors(self):
        origin = self.headers.get('Origin')
        if origin and (self.server.origins is None or origin in self.server.origins):
            return {'Access-Control-Allow-Origin': origin, 'Vary': 'Origin', 'Access-Control-Expose-Headers': 'ETag'}
        return {}

    def _send(self, status, body=b'', headers=None, head_only=False):
        self.send_response(status)
        for k, v in {**self._cors(), **(headers or {})}.items():
            self.send_header(k, v)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        if body and not head_only:
            self.wfile.write(body)

    def _error(self, err):
        body = json.dumps({'error': err.code, 'message': err.message}).encode()
        self._send(err.status, body, {'Content-Type': 'application/json', **err.headers})

    def _guard(self):
        """Host, Origin and token checks; returns the path segments under /storage/."""
        refusal = self._refusal()
        if refusal:
            self.log_message('refused: %s', refusal)
            raise HttpError(403, 'forbidden', refusal)
        ip = self.client_address[0]
        if self.server.throttle.blocked(ip):
            raise HttpError(429, 'rate_limited', 'Too many failed tokens. Wait a minute.')
        auth = self.headers.get('Authorization', '')
        token = auth[7:] if auth.startswith('Bearer ') else ''
        if not any(secrets.compare_digest(token, t) for t in self.server.tokens()):
            self.server.throttle.fail(ip)
            raise HttpError(401, 'unauthorized', 'Missing or invalid token.')

        raw = urllib.parse.urlsplit(self.path).path
        if not raw.startswith('/storage/'):
            raise HttpError(404, 'not_found', 'Not found.')
        rest = raw[len('/storage/'):]
        is_folder = rest == '' or rest.endswith('/')
        segments = [urllib.parse.unquote(s) for s in rest.split('/')]
        if is_folder:
            segments = segments[:-1]
        return segments, is_folder

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length > MAX_FILE_SIZE:
            raise HttpError(413, 'too_large', f'Limit is {MAX_FILE_SIZE} bytes.')
        return self.rfile.read(length)

    def _run(self, fn):
        try:
            fn()
        except HttpError as err:
            self._error(err)
        except Exception as err:   # keep serving; report it
            self.log_error('%r', err)
            self._error(HttpError(500, 'internal', 'Server error.'))

    # -- methods -----------------------------------------------------------

    def do_OPTIONS(self):
        refusal = self._refusal()
        if refusal:
            self.log_message('refused: %s', refusal)
            return self._send(403)
        self._send(204, headers={
            'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match',
            'Access-Control-Max-Age': '600',
        })

    def do_GET(self, head_only=False):
        def run():
            segments, is_folder = self._guard()
            store = self.server.store
            path = store.resolve(segments)
            if is_folder:
                items = store.listing(path)
                etag = store.versions.folder(items)
                if self._not_modified(etag):
                    return self._send(304, headers=etag_header(etag))
                body = json.dumps({'@context': 'http://remotestorage.io/spec/folder-description', 'items': items}).encode()
                return self._send(200, body, {'Content-Type': 'application/ld+json', **etag_header(etag)}, head_only)
            if not os.path.isfile(path):
                raise HttpError(404, 'not_found', 'No such document.')
            etag = store.versions.file(path)
            if self._not_modified(etag):
                return self._send(304, headers=etag_header(etag))
            with open(path, 'rb') as f:
                body = f.read()
            self._send(200, body, {'Content-Type': content_type(path), **etag_header(etag)}, head_only)
        self._run(run)

    def do_HEAD(self):
        self.do_GET(head_only=True)

    def _not_modified(self, etag):
        header = self.headers.get('If-None-Match')
        return header is not None and etag in {t.strip().removeprefix('W/').strip('"') for t in header.split(',')}

    def do_PUT(self):
        def run():
            segments, is_folder = self._guard()
            if is_folder:
                raise HttpError(400, 'bad_path', 'Cannot PUT a folder.')
            store = self.server.store
            path = store.resolve(segments)
            body = self._body()
            with store.write_lock:
                store.check_parents(segments)
                current = store.current_etag(path)
                check_precondition(self.headers, current)
                os.makedirs(os.path.dirname(path), exist_ok=True)
                # Keep an existing file's mode; a new one gets the usual umask'd mode.
                mode = os.stat(path).st_mode & 0o7777 if current is not None else 0o666 & ~UMASK
                fd, tmp = tempfile.mkstemp(prefix=TMP_PREFIX, dir=os.path.dirname(path))
                try:
                    os.fchmod(fd, mode)
                    with os.fdopen(fd, 'wb') as f:
                        f.write(body)
                        f.flush()
                        os.fsync(f.fileno())
                    os.replace(tmp, path)
                except BaseException:
                    if os.path.exists(tmp):
                        os.remove(tmp)
                    raise
                etag = store.versions.file(path)
            self._send(201 if current is None else 200, headers=etag_header(etag))
        self._run(run)

    def do_DELETE(self):
        def run():
            segments, is_folder = self._guard()
            if is_folder:
                raise HttpError(400, 'bad_path', 'Cannot DELETE a folder.')
            store = self.server.store
            path = store.resolve(segments)
            with store.write_lock:
                current = store.current_etag(path)
                if self.headers.get('If-Match') is None:
                    raise HttpError(428, 'precondition_required', 'Send If-Match.')
                if current is None:
                    raise HttpError(404, 'not_found', 'No such document.')
                check_precondition(self.headers, current)
                os.remove(path)
            self._send(200, headers=etag_header(current))
        self._run(run)

    def log_message(self, fmt, *args):
        if not self.server.quiet:
            sys.stderr.write('%s %s\n' % (self.address_string(), fmt % args))


class Throttle:
    """At most 10 failed tokens per IP per minute, then 429 for a minute."""
    def __init__(self, limit=10, window=60):
        self.limit, self.window, self.fails, self.lock = limit, window, {}, threading.Lock()

    def fail(self, ip):
        now = time.monotonic()
        with self.lock:
            self.fails[ip] = [t for t in self.fails.get(ip, []) if now - t < self.window] + [now]

    def blocked(self, ip):
        now = time.monotonic()
        with self.lock:
            return len([t for t in self.fails.get(ip, []) if now - t < self.window]) >= self.limit


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, store, tokens_file, origins, hosts, quiet):
        self.address_family = socket.AF_INET6 if ':' in addr[0] else socket.AF_INET
        super().__init__(addr, Handler)
        self.store, self.tokens_file, self.origins, self.hosts, self.quiet = store, tokens_file, origins, hosts, quiet
        self.throttle = Throttle()

    def tokens(self):
        """Re-read on each request, so removing a line revokes a device at once."""
        try:
            with open(self.tokens_file) as f:
                return [line.split(':', 1)[1].strip() for line in f if ':' in line and line.split(':', 1)[1].strip()]
        except FileNotFoundError:
            return []


# ---------------------------------------------------------------------------
# Tokens and TLS
# ---------------------------------------------------------------------------

def add_token(tokens_file, name):
    os.makedirs(os.path.dirname(tokens_file), exist_ok=True)
    token = secrets.token_urlsafe(32)
    fd = os.open(tokens_file, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'a') as f:
        f.write(f'{name}:{token}\n')
    print(f'Token for "{name}" (paste it into the app\'s keychain; it is not shown again):\n{token}')


def openssl(*args):
    subprocess.run(['openssl', *args], check=True, capture_output=True)


def ensure_private_ca(state_dir, ips):
    """A name-constrained CA for these IPs, and a 1-year leaf renewed at startup."""
    d = os.path.join(state_dir, 'ca')
    os.makedirs(d, exist_ok=True)
    ca_key, ca_crt = os.path.join(d, 'ca.key'), os.path.join(d, 'ca.crt')
    key, crt = os.path.join(d, 'server.key'), os.path.join(d, 'server.crt')
    names = sorted(set(ips) | {'127.0.0.1'})
    ip_tag = os.path.join(d, 'ips')

    def read(p):
        with open(p) as f:
            return f.read()

    # A new CA whenever the IPs change: name constraints are fixed at creation.
    if not os.path.exists(ca_crt) or not os.path.exists(ip_tag) or read(ip_tag) != ','.join(names):
        permitted = ','.join([f'permitted;IP:{ip}/{"255.255.255.255" if ipaddress.ip_address(ip).version == 4 else "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"}' for ip in names] + ['permitted;DNS:localhost'])
        openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
                '-keyout', ca_key, '-out', ca_crt, '-days', '3650', '-subj', '/CN=gh-memo local CA',
                '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
                '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
                '-addext', f'nameConstraints=critical,{permitted}')
        os.chmod(ca_key, 0o600)
        with open(ip_tag, 'w') as f:
            f.write(','.join(names))
        if os.path.exists(crt):
            os.remove(crt)

    fresh = os.path.exists(crt) and subprocess.run(
        ['openssl', 'x509', '-checkend', str(30 * 86400), '-noout', '-in', crt], capture_output=True).returncode == 0
    if not fresh:
        csr = os.path.join(d, 'server.csr')
        ext = os.path.join(d, 'server.ext')
        with open(ext, 'w') as f:
            f.write('basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\n'
                    f'subjectAltName={",".join(["DNS:localhost"] + [f"IP:{ip}" for ip in names])}\n')
        openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
                '-keyout', key, '-out', csr, '-subj', '/CN=gh-memo local server')
        openssl('x509', '-req', '-in', csr, '-CA', ca_crt, '-CAkey', ca_key, '-CAcreateserial',
                '-out', crt, '-days', '365', '-extfile', ext)
        os.chmod(key, 0o600)
    return crt, key, ca_crt


def normalize_origin(text):
    """'https://Example.org/' -> 'https://example.org', as browsers send Origin."""
    if text == 'null':   # file:// pages
        return text
    u = urllib.parse.urlsplit(text.strip())
    if u.scheme not in ('http', 'https') or not u.netloc or u.path not in ('', '/') or u.query or u.fragment or '@' in u.netloc:
        raise ValueError(f'--allow-origin {text!r}: give scheme://host[:port], with no path')
    netloc = u.netloc.lower()
    default_port = ':443' if u.scheme == 'https' else ':80'
    if netloc.endswith(default_port):
        netloc = netloc[:-len(default_port)]
    return f'{u.scheme}://{netloc}'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('root', nargs='?', help='the directory to serve')
    ap.add_argument('--bind', default='127.0.0.1', help='address to listen on (default 127.0.0.1)')
    ap.add_argument('--port', type=int, default=8765)
    ap.add_argument('--ip', action='append', default=[], help='LAN IP the certificate is for (needed with --bind 0.0.0.0)')
    ap.add_argument('--cert', help='TLS certificate (e.g. from tailscale cert); skips the private CA')
    ap.add_argument('--key', help='TLS private key for --cert')
    ap.add_argument('--insecure-http', action='store_true', help='allow plain HTTP on a non-loopback address')
    ap.add_argument('--allow-origin', action='append', default=[], help='only let pages from this origin call the server, e.g. https://miuele.github.io (repeatable; default: any origin)')
    ap.add_argument('--host-name', action='append', default=[], help='extra accepted Host name, e.g. notes.example.ts.net')
    ap.add_argument('--state-dir', default=os.path.join(os.path.expanduser('~'), '.config', 'gh-memo-server'), help='tokens and CA files')
    ap.add_argument('--add-token', metavar='NAME', help='create a token for one device, print it, and exit')
    ap.add_argument('--quiet', action='store_true')
    opts = ap.parse_args()
    sys.stdout.reconfigure(line_buffering=True)   # messages show up promptly in logs

    tokens_file = os.path.join(opts.state_dir, 'tokens')
    if opts.add_token:
        return add_token(tokens_file, opts.add_token)
    if not opts.root or not os.path.isdir(opts.root):
        ap.error('give the directory to serve')
    try:
        origins = {normalize_origin(o) for o in opts.allow_origin} if opts.allow_origin else None   # None: any
    except ValueError as err:
        ap.error(str(err))

    loopback = ipaddress.ip_address(opts.bind).is_loopback
    ips = opts.ip or ([] if loopback or opts.bind in ('0.0.0.0', '::') else [opts.bind])
    names = {'localhost', '127.0.0.1', '[::1]', *opts.host_name, *(f'[{ip}]' if ':' in ip else ip for ip in ips)}
    hosts = {f'{n}:{opts.port}'.lower() for n in names}

    tls = None
    if opts.cert:
        tls = (opts.cert, opts.key or opts.cert)
    elif not loopback and not opts.insecure_http:
        if not ips:
            ap.error('with --bind 0.0.0.0, name the LAN IP(s) for the certificate with --ip')
        crt, key, ca = ensure_private_ca(opts.state_dir, ips)
        tls = (crt, key)
        print(f'Private CA: import {ca} on each device (see README).')

    server = Server((opts.bind, opts.port), Store(opts.root), tokens_file,
                    origins, hosts, opts.quiet)
    if tls:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(*tls)
        server.socket = ctx.wrap_socket(server.socket, server_side=True)
    scheme = 'https' if tls else 'http'
    shown = ips[0] if ips else ('127.0.0.1' if loopback else opts.bind)
    if not server.tokens():
        print(f'No tokens yet: run  {sys.argv[0]} --add-token <device>')
    print(f'Serving {os.path.realpath(opts.root)} at {scheme}://{shown if ":" not in shown else f"[{shown}]"}:{opts.port}/storage/')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
