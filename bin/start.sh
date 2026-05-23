#!/usr/bin/env bash
set -Eeuo pipefail

export PORT="${PORT:-10000}"
export DISPLAY="${DISPLAY:-:99}"
export RESOLUTION="${RESOLUTION:-1440x900x24}"
export VNC_PORT="${VNC_PORT:-5900}"
export NOVNC_PORT="${NOVNC_PORT:-6080}"
export CHROME_HOME="${CHROME_HOME:-https://www.google.com}"
export HOME="${HOME:-/home/browser}"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_CACHE_HOME="$HOME/.cache"

if [[ -z "${VNC_PASSWORD:-}" ]]; then
  export VNC_PASSWORD="12345"
fi

mkdir -p "$HOME/Downloads" "$HOME/.config/chromium" "$HOME/.cache" /tmp/chromium-profile
chmod 700 /tmp/chromium-profile || true

IFS='x' read -r WIDTH HEIGHT DEPTH <<< "$RESOLUTION"
WIDTH="${WIDTH:-1440}"
HEIGHT="${HEIGHT:-900}"
DEPTH="${DEPTH:-24}"

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT SIGINT SIGTERM

echo "Starting Xvfb on ${DISPLAY} at ${WIDTH}x${HEIGHT}x${DEPTH}..."
Xvfb "$DISPLAY" -screen 0 "${WIDTH}x${HEIGHT}x${DEPTH}" -ac +extension RANDR -nolisten tcp >/tmp/xvfb.log 2>&1 &
sleep 2

echo "Starting Openbox window manager..."
openbox-session >/tmp/openbox.log 2>&1 &
sleep 2

echo "Starting x11vnc on localhost:${VNC_PORT}..."
x11vnc \
  -display "$DISPLAY" \
  -rfbport "$VNC_PORT" \
  -listen 127.0.0.1 \
  -forever \
  -shared \
  -noxdamage \
  -repeat \
  -passwd "$VNC_PASSWORD" \
  -o /tmp/x11vnc.log >/tmp/x11vnc.stdout.log 2>&1 &
sleep 2

echo "Starting websockify on localhost:${NOVNC_PORT}..."
websockify --verbose "127.0.0.1:${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" >/tmp/websockify.log 2>&1 &
sleep 2

echo "Starting portal server on :${PORT}..."
node /app/server-render.js &
NODE_PID=$!
sleep 2

echo "Launching Chromium..."
(
  while true; do
    chromium \
      --no-sandbox \
      --disable-dev-shm-usage \
      --disable-gpu \
      --disable-background-networking \
      --disable-sync \
      --disable-default-apps \
      --disable-extensions \
      --disable-notifications \
      --disable-features=TranslateUI,MediaRouter,AutofillServerCommunication \
      --no-first-run \
      --no-default-browser-check \
      --password-store=basic \
      --start-maximized \
      --window-size="${WIDTH},${HEIGHT}" \
      --force-device-scale-factor=1 \
      --user-data-dir=/tmp/chromium-profile \
      --proxy-pac-url="http://127.0.0.1:${PORT}/proxy.pac" \
      --incognito \
      "$CHROME_HOME" >/tmp/chromium.log 2>&1 || true
    echo "Chromium exited. Restarting in 2 seconds..."
    sleep 2
  done
) &

wait "$NODE_PID"
