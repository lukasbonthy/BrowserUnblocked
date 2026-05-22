# Chromium noVNC Portal v1

Render-ready web portal that gives users a Chromium browser inside the browser without downloads.

This v1 uses a real Linux virtual desktop:

```txt
User browser
  -> Express portal
  -> noVNC client
  -> websockify
  -> x11vnc
  -> Xvfb + Openbox
  -> Chromium
```

## Important v1 note

This is a **single shared Chromium desktop per Render service/container**. It is perfect for a private prototype or a trusted small group. For true one-browser-per-user isolation, you would need one container per user/session, a worker pool, or a VPS/Kubernetes-style setup.

## Features

- Render Docker deploy ready
- noVNC embedded in a premium portal UI
- Chromium running in Xvfb
- x11vnc + websockify bridge
- Portal password support through `PORTAL_PASSWORD`
- VNC password support through `VNC_PASSWORD`
- URL bar controls using `xdotool`
- Back, forward, reload, home, new tab, fullscreen controls
- Basic localhost/private-network blocking with a Chromium PAC file
- Health check at `/health`

## Deploy on Render

1. Push this folder to GitHub.
2. Create a new Render **Web Service**.
3. Choose **Docker** as the environment.
4. Use a paid/starter instance for best results. Chromium + noVNC is heavy for a free service.
5. Add these environment variables:

```env
PORTAL_PASSWORD=your-login-password
VNC_PASSWORD=your-vnc-password
CHROME_HOME=https://www.google.com
RESOLUTION=1440x900x24
```

`render.yaml` is included, so Render can also auto-create the service from the repo.

## Local Docker test

```bash
docker build -t chromium-novnc-portal-v1.1 .
docker run --rm -p 10000:10000 \
  -e PORTAL_PASSWORD=test \
  -e VNC_PASSWORD=testvnc \
  chromium-novnc-portal-v1.1
```

Then open:

```txt
http://localhost:10000
```

## Security notes

This is a prototype, not a hardened public browser-as-a-service platform.

The app includes a PAC file that blocks obvious local/private network destinations like `localhost`, `127.0.0.1`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, and `169.254.169.254`. That helps reduce SSRF/internal-network abuse, but it is not a full sandbox.

For public use, add stronger isolation:

- one container per user
- strict egress firewall rules
- bandwidth/session quotas
- automatic session reset
- content/download limits
- abuse monitoring

## Project structure

```txt
.
├── Dockerfile
├── render.yaml
├── package.json
├── server.js
├── bin/start.sh
├── public/index.html
├── public/style.css
└── public/app.js
```


## v1.1 fix

This build forces noVNC to use secure WebSockets on Render HTTPS and adds `/api/debug` after login for checking Xvfb/x11vnc/websockify/Chromium logs.
