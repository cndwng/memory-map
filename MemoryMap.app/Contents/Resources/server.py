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
import html
import http.server
import json
import os
import socketserver
import subprocess
import sys
import urllib.parse


RES_DIR = os.path.dirname(os.path.abspath(__file__))
# Runtime data lives in macOS's per-user Application Support, NOT inside the
# .app bundle (bundles become read-only once installed/code-signed). Static
# templates and scripts stay in RES_DIR.
DATA_DIR = os.path.join(os.path.expanduser('~'),
                        'Library', 'Application Support', 'MemoryMap')
BUILD_SCRIPT = os.path.join(RES_DIR, 'build.py')
DEFAULT_DATA_FILE = os.path.join(DATA_DIR, 'memory-map.json')
CONFIG_FILE = os.path.join(DATA_DIR, 'config.local.json')


def load_config():
    """Read config.local.json from the app's data dir. Returns a dict; empty if missing/bad."""
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
    data_error = None
    if os.path.exists(data_path):
        try:
            with open(data_path, 'r', encoding='utf-8') as f:
                raw = f.read()
            # Make sure it actually parses — otherwise we'd inject garbage
            # into the page and leave the UI uninteractable.
            json.loads(raw)
            data = raw
        except Exception as e:
            data_error = str(e)
    else:
        data_error = f'Data file not found: {data_path}'

    # Escape </ so user content can't accidentally close the <script> tag.
    data = data.replace('</', '<\\/')
    # Also defang HTML comment delimiters inside the script.
    data = data.replace('<!--', '<\\!--').replace('-->', '--\\>')
    data_script = 'window.MEMORY_MAP_DATA = ' + data + ';'

    if data_error:
        # Bail out with a self-contained recovery page so the user is never
        # stranded with a blank/broken view if they pointed at a bad file.
        return _recovery_page(data_error, data_path)

    out = template
    out = out.replace('/*__CSS__*/', css)
    out = out.replace('/*__MARKED__*/', marked_js)
    out = out.replace('/*__APP_JS__*/', js)
    out = out.replace('/*__DATA__*/', data_script)
    if focus:
        out = out.replace('<body>', '<body class="focus-mode">', 1)
    return out


class ViewerError(Exception):
    pass


def render_viewer(raw_path):
    """Read a .md file from disk and return a self-contained viewer HTML page."""
    if not raw_path:
        raise ViewerError('No file specified.')
    path = os.path.expanduser(raw_path)
    if not os.path.isabs(path):
        raise ViewerError(f'Path must be absolute: {raw_path}')
    real = os.path.realpath(path)
    home_real = os.path.realpath(os.path.expanduser('~'))
    # Defensive: only allow files inside the user's home dir.
    if not real.startswith(home_real + os.sep) and real != home_real:
        raise ViewerError(f'File is outside your home directory: {real}')
    if not os.path.isfile(real):
        raise ViewerError(f'Not a regular file: {real}')
    if not real.lower().endswith(('.md', '.markdown', '.mdown')):
        raise ViewerError(f"Not a markdown file: {os.path.basename(real)}")
    try:
        with open(real, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
    except Exception as e:
        raise ViewerError(f'Could not read file: {e}')

    template_path = os.path.join(RES_DIR, 'viewer.html')
    with open(template_path) as f:
        template = f.read()
    marked_path = os.path.join(RES_DIR, 'marked.min.js')
    with open(marked_path) as f:
        marked_js = f.read()

    filename = os.path.basename(real)
    crumb = real.replace(home_real, '~', 1) if real.startswith(home_real) else real

    out = template
    out = out.replace('__TITLE__', html.escape(filename))
    out = out.replace('__CRUMB__', html.escape(crumb))
    out = out.replace('/*__MARKED__*/', marked_js)
    # JSON-encode content so the JS can safely consume it as a string literal.
    content_safe = json.dumps(content).replace('</', '<\\/')
    out = out.replace('__CONTENT_JSON__', content_safe)
    return out


def render_viewer_error(message):
    return f'''<!doctype html>
<html><head><meta charset="utf-8"><title>Can't open file</title>
<style>
  body {{
    font: 14px/1.5 -apple-system, system-ui, sans-serif;
    color: #1b1b18; background: #fafaf7;
    max-width: 560px; margin: 60px auto; padding: 0 24px;
  }}
  h1 {{ font-size: 18px; margin: 0 0 12px; }}
  .err {{
    background: #fff; border: 1px solid #e6e4dc; border-radius: 6px;
    padding: 12px; font-family: ui-monospace, Menlo, monospace; font-size: 12px;
    color: #b91c1c; margin: 8px 0;
  }}
</style></head>
<body><h1>Memory Map can't open that file</h1>
<div class="err">{html.escape(message)}</div>
<p>Supported: <code>.md</code>, <code>.markdown</code>, <code>.mdown</code> files inside your home directory.</p>
</body></html>'''


def _recovery_page(error_message, data_path):
    cfg = load_config()
    override = cfg.get('data_file')
    return f'''<!doctype html>
<html><head><meta charset="utf-8"><title>Memory Map — needs reset</title>
<style>
  body {{
    font: 14px/1.6 -apple-system, system-ui, sans-serif;
    color: #1b1b18; background: #fafaf7;
    max-width: 560px; margin: 80px auto; padding: 0 24px;
  }}
  h1 {{ font-size: 22px; margin: 0 0 16px; }}
  p {{ color: #6b6b63; }}
  code {{ background: #f0ede2; padding: 2px 5px; border-radius: 3px; font-size: 12px; }}
  button {{
    background: #1b1b18; color: #fff; border: none;
    padding: 10px 16px; border-radius: 6px;
    font: inherit; cursor: pointer; margin-top: 16px;
  }}
  button:hover {{ opacity: 0.85; }}
  .err {{
    background: #fff; border: 1px solid #e6e4dc; border-radius: 6px;
    padding: 12px; font-family: ui-monospace, Menlo, monospace; font-size: 12px;
    color: #b91c1c; margin: 12px 0;
    white-space: pre-wrap;
  }}
</style></head>
<body>
  <h1>Memory Map can't load its data file</h1>
  <p>The configured data file isn't valid JSON. This usually happens after picking the wrong file via "📄 Use external data file…".</p>
  <p><strong>Active data file:</strong><br><code>{html.escape(data_path)}</code></p>
  {f'<p><strong>Override set in config:</strong> <code>{html.escape(override)}</code></p>' if override else ''}
  <div class="err">{html.escape(error_message)}</div>
  <button onclick="reset()">↺ Reset to defaults &amp; reload</button>
  <p style="margin-top:24px;font-size:12px;">Or quit the app and edit <code>~/Library/Application Support/MemoryMap/config.local.json</code> directly.</p>
<script>
  async function reset() {{
    await fetch('/api/reset-config', {{ method: 'POST' }});
    location.reload();
  }}
</script>
</body></html>
'''


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
        # Standalone markdown viewer — opened via .md file association.
        if self.path.startswith('/view'):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            file_arg = (qs.get('file') or [''])[0]
            try:
                body = render_viewer(file_arg).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
            except ViewerError as e:
                body = render_viewer_error(str(e)).encode('utf-8')
                self.send_response(404)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return

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
            # Show a native macOS file picker for .json files. Validate that
            # the pick is a .json file AND parses as JSON before saving the
            # config — picking a non-JSON or malformed file otherwise leaves
            # the app in an unrenderable state.
            try:
                proc = subprocess.run(
                    ['osascript', '-e',
                     'POSIX path of (choose file with prompt "Select a Memory Map JSON file" of type {"public.json"})'],
                    capture_output=True, text=True, timeout=120,
                )
                if proc.returncode != 0:
                    self._json({'ok': False, 'cancelled': True})
                    return
                picked = proc.stdout.strip()
                if not picked or not os.path.isfile(picked):
                    self._json({'ok': False, 'stderr': 'Not a file.'}, status=400)
                    return
                if not picked.lower().endswith('.json'):
                    self._json({'ok': False,
                                'stderr': f"That file isn't a .json (picked: {os.path.basename(picked)}). Try again."},
                               status=400)
                    return
                # Validate it actually parses.
                try:
                    with open(picked) as f:
                        json.load(f)
                except Exception as e:
                    self._json({'ok': False,
                                'stderr': f"That file isn't valid JSON ({e}). Try again."},
                               status=400)
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
