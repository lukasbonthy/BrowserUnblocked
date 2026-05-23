#!/usr/bin/env bash
set -e
nginx -c /etc/nginx/nginx.conf
exec /dockerstartup/kasm_default_profile.sh
