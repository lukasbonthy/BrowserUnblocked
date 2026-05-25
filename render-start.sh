#!/usr/bin/env bash
set -e

export MAX_ACTIVE_SESSIONS="${MAX_ACTIVE_SESSIONS:-8}"

mkdir -p /tmp/browserunblocked-nginx /app/storage /app/storage/profiles /app/storage/homes
chmod -R 777 /app/storage || true
printf '# BrowserUnblocked dynamic session routes live here\n' > /tmp/browserunblocked-nginx/placeholder.conf

# The SQLite DB lives on the persistent disk, so rows from old deploys/restarts
# can survive even though the old KasmVNC processes are gone. Clear runtime-only
# session rows on boot so stale PIDs do not make new users get 503 errors.
python3 - <<'PY'
import os, sqlite3
path = os.path.join(os.environ.get('APP_STORAGE', '/app/storage'), 'browserunblocked.db')
os.makedirs(os.path.dirname(path), exist_ok=True)
try:
    con = sqlite3.connect(path, timeout=15)
    con.execute('CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, uid INTEGER UNIQUE, route TEXT UNIQUE, display INTEGER, web_port INTEGER, vnc_port INTEGER, pid INTEGER, app TEXT, created INTEGER, seen INTEGER)')
    con.execute('DELETE FROM sessions')
    con.commit()
    con.close()
    print('Cleared stale BrowserUnblocked runtime sessions from persistent DB')
except Exception as exc:
    print('Session cleanup skipped:', exc)
PY

echo "Starting BrowserUnblocked session controller on 127.0.0.1:${CONTROL_PORT:-7070}"
echo "MAX_ACTIVE_SESSIONS=${MAX_ACTIVE_SESSIONS}"
python3 /control_server.py &

echo "Starting nginx proxy on port ${PORT:-10000}"
nginx -t
nginx -c /etc/nginx/nginx.conf

echo "BrowserUnblocked ready. User KasmVNC sessions start on demand."
tail -f /dev/null
