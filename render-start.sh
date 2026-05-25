#!/usr/bin/env bash
set -e

export MAX_ACTIVE_SESSIONS="${MAX_ACTIVE_SESSIONS:-8}"

mkdir -p /tmp/browserunblocked-nginx /app/storage /app/storage/profiles /app/storage/homes
chmod -R 777 /app/storage || true
printf '# BrowserUnblocked dynamic session routes live here\n' > /tmp/browserunblocked-nginx/placeholder.conf

# Optional: set KASM_BASIC_AUTH_B64 in Render to the base64 of your internal KasmVNC username:password.
# This lets nginx answer KasmVNC's upstream Basic auth challenge internally, so users do not see a browser popup.
if [ -n "${KASM_BASIC_AUTH_B64:-}" ]; then
  sed -i "s#__KASM_BASIC_AUTH__#${KASM_BASIC_AUTH_B64}#g" /etc/nginx/conf.d/default.conf
  echo "Configured nginx with internal KasmVNC auth header"
else
  sed -i '/__KASM_BASIC_AUTH__/d' /etc/nginx/conf.d/default.conf
  echo "KASM_BASIC_AUTH_B64 not set; nginx will not inject KasmVNC auth"
fi

# Patch controller at boot so private Kasm sessions use the stable nginx route:
# /p/<internal-port>/<route>/... instead of dynamic /s/<route>/... includes.
python3 - <<'PY'
path = '/control_server.py'
try:
    s = open(path, 'r', encoding='utf-8').read()
    s = s.replace("MAX_SESSIONS=int(os.environ.get('MAX_ACTIVE_SESSIONS','3'))", "MAX_SESSIONS=int(os.environ.get('MAX_ACTIVE_SESSIONS','8'))")
    old = "def viewer(route): return '/s/%s/vnc.html?resize=scale&reconnect=1&autoconnect=1&path=s/%s/websockify'%(route,route)"
    new = "def viewer(route, web_port=None):\n if web_port is None: return '/s/%s/vnc.html?resize=scale&reconnect=1&autoconnect=1&path=s/%s/websockify'%(route,route)\n return '/p/%s/%s/vnc.html?resize=scale&reconnect=1&autoconnect=1&path=p/%s/%s/websockify'%(web_port,route,web_port,route)"
    s = s.replace(old, new)
    s = s.replace("viewer(s['route']) if s", "viewer(s['route'],s['web_port']) if s")
    s = s.replace("viewer(s['route']) if s else", "viewer(s['route'],s['web_port']) if s else")
    s = s.replace("viewer(s['route']),app", "viewer(s['route'],s['web_port']),app")
    open(path, 'w', encoding='utf-8').write(s)
    print('Patched control_server.py for stable /p/<port>/<route> viewer URLs')
except Exception as exc:
    print('Controller patch skipped:', exc)
PY

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
