#!/usr/bin/env bash
set -e

echo "Starting nginx proxy on port ${PORT:-10000}"
nginx -t
nginx -c /etc/nginx/nginx.conf

echo "Starting KasmVNC with Chromium"
exec /dockerstartup/kasm_default_profile.sh /dockerstartup/vnc_startup.sh /dockerstartup/custom_startup.sh --wait
