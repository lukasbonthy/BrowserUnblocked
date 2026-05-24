#!/usr/bin/env python3
import json
import os
import shlex
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HOST = "127.0.0.1"
PORT = int(os.environ.get("CONTROL_PORT", "7070"))
DISPLAY = os.environ.get("APP_DISPLAY", ":1")


def shell_quote(value: str) -> str:
    return shlex.quote(value)


def run_detached(command: str) -> None:
    env = os.environ.copy()
    env["DISPLAY"] = DISPLAY
    env.setdefault("HOME", "/home/kasm-user")
    subprocess.Popen(
        ["bash", "-lc", command],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        env=env,
        start_new_session=True,
    )


def chromium_app(url: str, profile: str) -> str:
    return (
        f"mkdir -p /home/kasm-user/.browserunblocked/{shell_quote(profile)}; "
        f"nohup chromium "
        f"--no-first-run --no-default-browser-check --disable-sync --disable-notifications "
        f"--disable-background-networking --mute-audio "
        f"--user-data-dir=/home/kasm-user/.browserunblocked/{shell_quote(profile)} "
        f"--app={shell_quote(url)} >/tmp/browserunblocked-{shell_quote(profile)}.log 2>&1 &"
    )


def normal_browser(url: str) -> str:
    return (
        f"nohup chromium --no-first-run --no-default-browser-check --disable-sync "
        f"--disable-notifications --disable-background-networking --mute-audio "
        f"--new-window {shell_quote(url)} >/tmp/browserunblocked-chromium.log 2>&1 &"
    )


APPS = {
    "chromium": {
        "label": "Chromium",
        "command": normal_browser("https://lite.duckduckgo.com/lite/"),
    },
    "chrome": {
        "label": "Chrome-style browser",
        "command": normal_browser("https://www.google.com/"),
    },
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
    "discord": {
        "label": "Discord",
        "command": chromium_app("https://discord.com/app", "discord"),
    },
    "brave": {
        "label": "Brave Search",
        "command": chromium_app("https://search.brave.com/", "brave"),
    },
    "edge": {
        "label": "Edge / Bing",
        "command": chromium_app("https://www.bing.com/", "edge"),
    },
    "desktop": {
        "label": "Desktop",
        "command": "nohup xfce4-appfinder >/tmp/browserunblocked-desktop.log 2>&1 &",
    },
    "terminal": {
        "label": "Terminal",
        "command": "nohup bash -lc 'x-terminal-emulator || xfce4-terminal || xterm' >/tmp/browserunblocked-terminal.log 2>&1 &",
    },
}


class Handler(BaseHTTPRequestHandler):
    def _json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _redirect(self, target: str) -> None:
        self.send_response(302)
        self.send_header("Location", target)
        self.end_headers()

    def do_GET(self) -> None:
        path = urlparse(self.path).path.rstrip("/")

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
                if path.startswith("/open/"):
                    self._redirect("/launch")
                else:
                    self._json(200, {"ok": True, "app": app, "label": item["label"]})
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
