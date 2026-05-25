#!/usr/bin/env bash
set -e

mkdir -p /tmp/browserunblocked-nginx /app/storage /app/storage/profiles /app/storage/homes
chmod -R 777 /app/storage || true
printf '# BrowserUnblocked dynamic session routes live here\n' > /tmp/browserunblocked-nginx/placeholder.conf

echo "Starting BrowserUnblocked session controller on 127.0.0.1:${CONTROL_PORT:-7070}"
python3 /control_server.py &

echo "Starting nginx proxy on port ${PORT:-10000}"
nginx -t
nginx -c /etc/nginx/nginx.conf

echo "BrowserUnblocked ready. User KasmVNC sessions start on demand."
tail -f /dev/null
