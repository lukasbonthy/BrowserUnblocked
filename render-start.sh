#!/usr/bin/env bash
set -e

echo "Starting BrowserUnblocked app controller on 127.0.0.1:${CONTROL_PORT:-7070}"
python3 /control_server.py &

echo "Starting nginx proxy on port ${PORT:-10000}"
nginx -t
nginx -c /etc/nginx/nginx.conf

# The stock Kasm image starts sidecar services we do not use on Render
# (smartcard/gamepad/pcsc). Render has no physical devices for them, so they can
# spam logs with bridge->relay timeout messages forever. Kill only those
# optional sidecars after KasmVNC has had time to boot.
(
  sleep 25
  pkill -f smartcard || true
  pkill -f pcscd || true
  pkill -f KasmGamepadServer || true
  pkill -f gamepad || true
) >/dev/null 2>&1 &

echo "Starting KasmVNC with Chromium"
exec /dockerstartup/kasm_default_profile.sh /dockerstartup/vnc_startup.sh /dockerstartup/custom_startup.sh --wait
