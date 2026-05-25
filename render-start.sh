#!/usr/bin/env bash
set -e

mkdir -p /tmp/browserunblocked-nginx
# nginx include globs fail if the directory exists but is empty on some builds,
# so keep a harmless placeholder config here for dynamic per-session routes.
printf '# BrowserUnblocked dynamic session routes live here\n' > /tmp/browserunblocked-nginx/placeholder.conf

echo "Starting BrowserUnblocked app controller on 127.0.0.1:${CONTROL_PORT:-7070}"
python3 /control_server.py &

echo "Starting nginx proxy on port ${PORT:-10000}"
nginx -t
nginx -c /etc/nginx/nginx.conf

echo "Starting KasmVNC with Chromium"
exec /dockerstartup/kasm_default_profile.sh /dockerstartup/vnc_startup.sh /dockerstartup/custom_startup.sh --wait
