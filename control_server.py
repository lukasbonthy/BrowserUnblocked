#!/usr/bin/env python3
import html
import json
import os
import shlex
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HOST = "127.0.0.1"
PORT = int(os.environ.get("CONTROL_PORT", "7070"))
DISPLAY = os.environ.get("APP_DISPLAY", ":1")
DISPLAY_NUM = DISPLAY.replace(":", "", 1)
HOME_DIR = "/home/kasm-user"
VIEWER_URL = "/vnc.html?resize=scale&reconnect=1"


def shell_quote(value: str) -> str:
    return shlex.quote(value)


def wrap_for_display(command: str) -> str:
    return f"""
set +e
export DISPLAY={shell_quote(DISPLAY)}
export HOME={shell_quote(HOME_DIR)}
export XAUTHORITY={shell_quote(HOME_DIR)}/.Xauthority
for i in $(seq 1 90); do
  if [ -S /tmp/.X11-unix/X{shell_quote(DISPLAY_NUM)} ]; then
    break
  fi
  sleep 1
done
sleep 3
{command}
"""


def run_detached(command: str) -> None:
    env = os.environ.copy()
    env["DISPLAY"] = DISPLAY
    env["HOME"] = HOME_DIR
    env["XAUTHORITY"] = f"{HOME_DIR}/.Xauthority"
    subprocess.Popen(
        ["bash", "-lc", wrap_for_display(command)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        env=env,
        start_new_session=True,
    )


def chromium_cmd(extra: str, log_name: str) -> str:
    return (
        "BROWSER=$(command -v chromium || command -v chromium-browser || command -v google-chrome || true); "
        "if [ -z \"$BROWSER\" ]; then echo 'No chromium browser found' >&2; exit 0; fi; "
        f"nohup \"$BROWSER\" {extra} >/tmp/{shell_quote(log_name)}.log 2>&1 &"
    )


def chromium_app(url: str, profile: str) -> str:
    profile_dir = f"{HOME_DIR}/.browserunblocked/{profile}"
    args = (
        "--no-first-run --no-default-browser-check --disable-sync --disable-notifications "
        "--disable-background-networking --mute-audio "
        f"--user-data-dir={shell_quote(profile_dir)} --app={shell_quote(url)}"
    )
    return f"mkdir -p {shell_quote(profile_dir)}; {chromium_cmd(args, 'browserunblocked-' + profile)}"


def normal_browser(url: str, profile: str = "main") -> str:
    profile_dir = f"{HOME_DIR}/.browserunblocked/{profile}"
    args = (
        "--no-first-run --no-default-browser-check --disable-sync --disable-notifications "
        "--disable-background-networking --mute-audio "
        f"--user-data-dir={shell_quote(profile_dir)} --new-window {shell_quote(url)}"
    )
    return f"mkdir -p {shell_quote(profile_dir)}; {chromium_cmd(args, 'browserunblocked-' + profile)}"


APPS = {
    "chromium": {"label": "Chromium", "command": normal_browser("https://lite.duckduckgo.com/lite/", "chromium")},
    "chrome": {"label": "Chrome-style browser", "command": normal_browser("https://www.google.com/", "chrome")},
    "firefox": {
        "label": "Firefox",
        "command": (
            "if command -v firefox >/dev/null 2>&1; then "
            "nohup firefox --new-window https://www.google.com >/tmp/browserunblocked-firefox.log 2>&1 & "
            "else "
            + chromium_app("https://www.mozilla.org/firefox/", "firefox-fallback")
            + "; fi"
        ),
    },
    "discord": {"label": "Discord", "command": chromium_app("https://discord.com/app", "discord")},
    "brave": {"label": "Brave Search", "command": chromium_app("https://search.brave.com/", "brave")},
    "edge": {"label": "Edge / Bing", "command": chromium_app("https://www.bing.com/", "edge")},
    "desktop": {"label": "Desktop", "command": "nohup bash -lc 'xfce4-appfinder || true' >/tmp/browserunblocked-desktop.log 2>&1 &"},
    "terminal": {"label": "Terminal", "command": "nohup bash -lc 'x-terminal-emulator || xfce4-terminal || xterm || true' >/tmp/browserunblocked-terminal.log 2>&1 &"},
}


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _html(self, status: int, body: str) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _launch_page(self, app: str, label: str) -> str:
        safe_label = html.escape(label)
        safe_app = html.escape(app)
        return f'''<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Opening {safe_label}</title>
<meta http-equiv="refresh" content="4;url={VIEWER_URL}">
<style>
body{{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 20% 10%,rgba(59,213,255,.25),transparent 28%),linear-gradient(180deg,#07101f,#050713);color:#fff;font-family:system-ui,Segoe UI,sans-serif}}
.card{{width:min(520px,calc(100% - 28px));padding:30px;border:1px solid rgba(255,255,255,.14);border-radius:28px;background:rgba(255,255,255,.075);box-shadow:0 30px 90px rgba(0,0,0,.35);text-align:center}}
.spinner{{width:38px;height:38px;border-radius:999px;border:4px solid rgba(255,255,255,.18);border-top-color:#3bd5ff;margin:0 auto 18px;animation:spin 1s linear infinite}}@keyframes spin{{to{{transform:rotate(360deg)}}}}
h1{{margin:0 0 10px;font-size:28px;letter-spacing:-.04em}}p{{margin:0;color:rgba(255,255,255,.72);line-height:1.55}}a{{display:inline-block;margin-top:18px;color:#9cefff;font-weight:900;text-decoration:none}}
</style></head><body><main class="card"><div class="spinner"></div><h1>Opening {safe_label}</h1><p>The app launch was queued inside the running Kasm session. You will be sent to the viewer in a few seconds.</p><a href="{VIEWER_URL}">Open workspace now →</a><p style="margin-top:14px;font-size:12px;opacity:.55">App id: {safe_app}</p></main></body></html>'''

    def do_HEAD(self) -> None:
        self._json(200, {"ok": True})

    def do_GET(self) -> None:
        path = urlparse(self.path).path.rstrip("/") or "/"

        if path in {"/", "/health"}:
            self._json(200, {"ok": True, "service": "browserunblocked-control"})
            return

        if path in {"/api/apps", "/apps.json"}:
            self._json(200, {"ok": True, "apps": sorted(APPS.keys())})
            return

        if path.startswith("/api/open/") or path.startswith("/open/"):
            app = path.split("/")[-1].lower().strip()
            item = APPS.get(app)
            if not item:
                self._json(404, {"ok": False, "error": f"Unknown app: {app}"})
                return
            try:
                run_detached(item["command"])
                print(f"control_server: queued app launch: {app}", flush=True)
                if path.startswith("/open/"):
                    self._html(200, self._launch_page(app, item["label"]))
                else:
                    self._json(200, {"ok": True, "app": app, "label": item["label"], "viewer": VIEWER_URL})
            except Exception as exc:
                self._json(500, {"ok": False, "error": str(exc)})
            return

        self._json(404, {"ok": False, "error": "Not found"})

    def log_message(self, fmt: str, *args) -> None:
        print("control_server:", fmt % args, flush=True)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"BrowserUnblocked control server listening on http://{HOST}:{PORT}", flush=True)
    server.serve_forever()
