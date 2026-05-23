#!/usr/bin/env python3
"""Memory Map local server.

Started by the .app bundle's MacOS/run launcher. Listens on 127.0.0.1 on an
OS-assigned port (prints it as the first stdout line so the launcher can read
it). Serves:

  GET  /              -> a single synthesized HTML built from template.html +
                         styles.css + marked.min.js + app.js + data/memory-map.json
  POST /api/rebuild   -> runs `python3 build.py` from the repo root and returns
                         { "ok": bool, "stderr": "..." }

PID is written to /tmp/memorymap.pid so subsequent launches can clean up.
"""
import http.server
import json
import os
import socketserver
import subprocess
import sys
import urllib.parse


def discover_paths():
    """Resolve the bundle Resources dir and the repo root from this script's location."""
    res_dir = os.path.dirname(os.path.abspath(__file__))
    # res_dir = .../MemoryMap.app/Contents/Resources
    bundle = os.path.dirname(os.path.dirname(res_dir))
    # bundle = .../MemoryMap.app
    repo = os.path.dirname(bundle)
    # repo = .../memory-map
    return res_dir, repo


RES_DIR, REPO = discover_paths()
# build.py lives next to this server (both inside Resources/) so the bundle is
# self-contained.
BUILD_SCRIPT = os.path.join(RES_DIR, 'build.py')
DEFAULT_DATA_FILE = os.path.join(REPO, 'data', 'memory-map.json')
CONFIG_FILE = os.path.join(REPO, 'data', 'config.local.json')


def load_config():
    """Read data/config.local.json. Returns a dict; empty if missing/bad."""
    if not os.path.isfile(CONFIG_FILE):
        return {}
    try:
        return json.load(open(CONFIG_FILE))
    except Exception:
        return {}


def save_config(cfg):
    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
    with open(CONFIG_FILE, 'w') as f:
        json.dump(cfg, f, indent=2)


def active_data_file():
    """Return the path to the JSON the viewer should read. Honors config.data_file
    when set and valid; otherwise falls back to the default sibling data file."""
    cfg = load_config()
    override = cfg.get('data_file')
    if override:
        override = os.path.expanduser(override)
        if os.path.isfile(override):
            return override
    return DEFAULT_DATA_FILE


def synthesize_html(focus=False):
    """Combine template + assets + data into a single HTML string.

    When `focus=True`, the body is rendered with the `focus-mode` class set,
    so the page loads already in focus mode (no chrome-fade animation).
    """
    def read(name):
        with open(os.path.join(RES_DIR, name), 'r', encoding='utf-8') as f:
            return f.read()

    template = read('template.html')
    css = read('styles.css')
    js = read('app.js')
    marked_js = read('marked.min.js')

    data = '{}'
    data_path = active_data_file()
    if os.path.exists(data_path):
        with open(data_path, 'r', encoding='utf-8') as f:
            data = f.read()

    # Escape </ so user content can't accidentally close the <script> tag.
    data = data.replace('</', '<\\/')
    # Also defang HTML comment delimiters inside the script.
    data = data.replace('<!--', '<\\!--').replace('-->', '--\\>')
    data_script = 'window.MEMORY_MAP_DATA = ' + data + ';'

    out = template
    out = out.replace('/*__CSS__*/', css)
    out = out.replace('/*__MARKED__*/', marked_js)
    out = out.replace('/*__APP_JS__*/', js)
    out = out.replace('/*__DATA__*/', data_script)
    if focus:
        out = out.replace('<body>', '<body class="focus-mode">', 1)
    return out


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Quiet logs (set MEMORYMAP_VERBOSE=1 to enable)
        if os.environ.get('MEMORYMAP_VERBOSE'):
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # Serve the favicon from the bundle so Chrome --app picks it up for
        # the Dock tile and window-title icon.
        if self.path in ('/favicon.png', '/favicon.ico'):
            try:
                with open(os.path.join(RES_DIR, 'favicon.png'), 'rb') as f:
                    body = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
            except Exception:
                self.send_response(404)
                self.end_headers()
            return
        if self.path == '/' or self.path.startswith('/?') or self.path == '/index.html':
            # Pull focus flag from query string so the page renders pre-focused
            # (no animation flash on popup launch).
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            focus = qs.get('focus', ['0'])[0] == '1'
            try:
                html = synthesize_html(focus=focus)
            except Exception as e:
                self.send_response(500)
                self.send_header('Content-Type', 'text/plain; charset=utf-8')
                self.end_headers()
                self.wfile.write(f'Server error rendering page: {e}\n'.encode())
                return
            body = html.encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == '/api/pick-data-file':
            # Show a native macOS file picker for .json files. On pick, write
            # the chosen path into config.data_file. Front-end reloads to apply.
            try:
                proc = subprocess.run(
                    ['osascript', '-e',
                     'POSIX path of (choose file with prompt "Select a Memory Map JSON file" of type {"json", "public.json"})'],
                    capture_output=True, text=True, timeout=120,
                )
                if proc.returncode != 0:
                    # User cancelled — not an error.
                    self._json({'ok': False, 'cancelled': True})
                    return
                picked = proc.stdout.strip()
                if not picked or not os.path.isfile(picked):
                    self._json({'ok': False, 'stderr': 'not a file'}, status=400)
                    return
                cfg = load_config()
                cfg['data_file'] = picked
                save_config(cfg)
                self._json({'ok': True, 'data_file': picked})
            except Exception as e:
                self._json({'ok': False, 'stderr': f'{type(e).__name__}: {e}'}, status=500)
            return

        if self.path == '/api/pick-workspace':
            # Native folder picker. On pick, write to config.workspace_dirs and
            # kick a rebuild so the workspace tab reflects the new dir.
            try:
                proc = subprocess.run(
                    ['osascript', '-e',
                     'POSIX path of (choose folder with prompt "Select your workspace folder (contains your code repos)")'],
                    capture_output=True, text=True, timeout=120,
                )
                if proc.returncode != 0:
                    self._json({'ok': False, 'cancelled': True})
                    return
                picked = proc.stdout.strip()
                if not picked or not os.path.isdir(picked):
                    self._json({'ok': False, 'stderr': 'not a dir'}, status=400)
                    return
                cfg = load_config()
                cfg['workspace_dirs'] = [picked.rstrip('/')]
                save_config(cfg)
                # Rebuild so the new dir's repos appear.
                build = subprocess.run(
                    ['python3', BUILD_SCRIPT],
                    capture_output=True, text=True, timeout=60,
                )
                self._json({
                    'ok': build.returncode == 0,
                    'workspace_dir': picked,
                    'stderr': build.stderr,
                })
            except Exception as e:
                self._json({'ok': False, 'stderr': f'{type(e).__name__}: {e}'}, status=500)
            return

        if self.path == '/api/reset-config':
            try:
                if os.path.isfile(CONFIG_FILE):
                    os.unlink(CONFIG_FILE)
                # Rebuild with defaults.
                build = subprocess.run(
                    ['python3', BUILD_SCRIPT], capture_output=True, text=True, timeout=60,
                )
                self._json({'ok': build.returncode == 0, 'stderr': build.stderr})
            except Exception as e:
                self._json({'ok': False, 'stderr': f'{type(e).__name__}: {e}'}, status=500)
            return

        if self.path.startswith('/api/popup'):
            # Spawn a new Chrome --app window pointing at this server with the
            # given path & focus mode pre-set. Avoids window.open() showing
            # browser chrome.
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            target_path = qs.get('path', [''])[0]
            port = self.server.server_address[1]
            url = f'http://127.0.0.1:{port}/?focus=1'
            if target_path:
                url += '&path=' + urllib.parse.quote(target_path)
            user_data = os.path.expanduser('~/Library/Application Support/MemoryMap/chrome-profile')
            try:
                subprocess.Popen(
                    [
                        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                        f'--app={url}',
                        f'--user-data-dir={user_data}',
                        '--no-first-run',
                        '--no-default-browser-check',
                        '--window-size=780,900',
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )
                payload = json.dumps({'ok': True}).encode()
                self.send_response(200)
            except Exception as e:
                payload = json.dumps({'ok': False, 'stderr': f'{type(e).__name__}: {e}'}).encode()
                self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path == '/api/rebuild':
            try:
                proc = subprocess.run(
                    ['python3', BUILD_SCRIPT],
                    capture_output=True, text=True, timeout=60,
                )
                ok = proc.returncode == 0
                payload = json.dumps({
                    'ok': ok,
                    'stdout': proc.stdout,
                    'stderr': proc.stderr,
                }).encode('utf-8')
                self.send_response(200 if ok else 500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except subprocess.TimeoutExpired:
                payload = json.dumps({'ok': False, 'stderr': 'build.py timed out (60s)'}).encode()
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except Exception as e:
                payload = json.dumps({'ok': False, 'stderr': f'{type(e).__name__}: {e}'}).encode()
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        else:
            self.send_response(404)
            self.end_headers()


class ThreadingTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


# Back-compat alias used below.
ReuseTCPServer = ThreadingTCPServer


def main():
    httpd = ReuseTCPServer(('127.0.0.1', 0), Handler)
    port = httpd.server_address[1]
    # Print the port on the first line so the launcher can read it.
    print(port, flush=True)
    # Record PID for cleanup on next launch.
    try:
        with open('/tmp/memorymap.pid', 'w') as f:
            f.write(str(os.getpid()))
    except Exception:
        pass
    try:
        httpd.serve_forever()
    finally:
        try:
            os.unlink('/tmp/memorymap.pid')
        except Exception:
            pass


if __name__ == '__main__':
    main()
