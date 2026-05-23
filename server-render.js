'use strict';

const crypto = require('crypto');
const { execFile } = require('child_process');
const net = require('net');
const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const helmet = require('helmet');
const { WebSocketServer } = require('ws');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const VNC_PORT = Number(process.env.VNC_PORT || 5900);
const VNC_PASSWORD = process.env.VNC_PASSWORD || '';
const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || '';
const CHROME_HOME = process.env.CHROME_HOME || 'https://www.google.com';
const NOVNC_WEB = process.env.NOVNC_WEB || '/usr/share/novnc';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

let wsClients = 0;
let lastWsEvent = 'none yet';

app.set('trust proxy', 1);
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));
app.use(cookieParser());

app.use(session({
  name: 'chromium_portal.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 8 * 60 * 60 * 1000 }
}));

function isAuthed(req) {
  return !PORTAL_PASSWORD || Boolean(req.session && req.session.authed === true);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ ok: false, error: 'Login required.' });
}

function safeCompare(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function runXd(args, ms = 7000) {
  return new Promise((resolve, reject) => {
    execFile('xdotool', args, { timeout: ms, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}${stderr ? `\n${stderr}` : ''}`));
      else resolve(stdout);
    });
  });
}

function runShell(command, ms = 7000) {
  return new Promise((resolve, reject) => {
    execFile('bash', ['-lc', command], { timeout: ms, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' } }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}${stderr ? `\n${stderr}` : ''}`));
      else resolve(stdout);
    });
  });
}

async function focusChromium() {
  await runShell(`
for i in $(seq 1 24); do
  wid="$(xdotool search --onlyvisible --class chromium 2>/dev/null | head -n 1 || true)"
  [ -z "$wid" ] && wid="$(xdotool search --onlyvisible --name Chromium 2>/dev/null | head -n 1 || true)"
  if [ -n "$wid" ]; then xdotool windowactivate --sync "$wid" 2>/dev/null || true; exit 0; fi
  sleep 0.25
done
exit 0
`, 9000).catch(() => '');
}

function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter a URL first.');
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withScheme);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https URLs are allowed.');
  return parsed.toString();
}

async function navigate(url) {
  await focusChromium();
  await runXd(['key', '--clearmodifiers', 'ctrl+l']);
  await runXd(['type', '--clearmodifiers', '--delay', '1', url], 10000);
  await runXd(['key', '--clearmodifiers', 'Return']);
}

async function browserAction(action) {
  await focusChromium();
  const map = {
    back: ['key', '--clearmodifiers', 'Alt_L+Left'],
    forward: ['key', '--clearmodifiers', 'Alt_L+Right'],
    reload: ['key', '--clearmodifiers', 'ctrl+r'],
    newtab: ['key', '--clearmodifiers', 'ctrl+t'],
    fullscreen: ['key', '--clearmodifiers', 'F11']
  };
  if (!map[action]) throw new Error('Unknown action.');
  await runXd(map[action]);
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'chromium-novnc-render-v1.4' }));
app.get('/proxy.pac', (req, res) => res.type('application/x-ns-proxy-autoconfig').send('function FindProxyForURL(url, host) { return "DIRECT"; }'));

app.get('/api/config', (req, res) => {
  const authed = isAuthed(req);
  res.json({ ok: true, requiresLogin: Boolean(PORTAL_PASSWORD), authenticated: authed, chromeHome: CHROME_HOME, vnc: authed ? { password: VNC_PASSWORD, path: 'websockify', resize: 'scale' } : null });
});

app.post('/api/login', (req, res) => {
  if (!PORTAL_PASSWORD || safeCompare(req.body.password, PORTAL_PASSWORD)) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: 'Wrong portal password.' });
});

app.post('/api/browser/navigate', requireAuth, async (req, res) => {
  try {
    const url = normalizeUrl(req.body.url);
    await navigate(url);
    res.json({ ok: true, url });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/browser/action', requireAuth, async (req, res) => {
  try {
    const action = String(req.body.action || '').toLowerCase();
    if (action === 'home') await navigate(normalizeUrl(CHROME_HOME));
    else await browserAction(action);
    res.json({ ok: true, action });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '0s', etag: false }));
app.use('/novnc', requireAuth, express.static(NOVNC_WEB, { maxAge: '0s', etag: false }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/debug', requireAuth, async (req, res) => {
  const fs = require('fs');
  const read = (file) => { try { return fs.readFileSync(file, 'utf8').slice(-5000); } catch { return ''; } };
  const processes = await runShell("ps aux | grep -E 'Xvfb|openbox|x11vnc|websockify|chromium|node' | grep -v grep || true", 3000).catch(err => err.message);
  const windows = await runShell("xdotool search --onlyvisible --name . getwindowname %@ 2>/dev/null || true", 3000).catch(err => err.message);
  res.type('text/plain').send([
    '=== build ===', 'server-render v1.4', `ws clients: ${wsClients}`, `last ws event: ${lastWsEvent}`,
    '=== processes ===', processes,
    '=== visible windows ===', windows,
    '=== x11vnc.log ===', read('/tmp/x11vnc.log') || read('/tmp/x11vnc.stdout.log'),
    '=== chromium.log ===', read('/tmp/chromium.log'),
    '=== websockify.log ===', read('/tmp/websockify.log')
  ].join('\n'));
});

const server = app.listen(PORT, () => console.log(`Portal listening on :${PORT}`));
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  wsClients += 1;
  lastWsEvent = `websocket connected ${new Date().toISOString()}`;
  const vnc = net.connect(VNC_PORT, '127.0.0.1');
  const queue = [];
  let ready = false;

  vnc.on('connect', () => { ready = true; lastWsEvent = `vnc tcp connected ${new Date().toISOString()}`; while (queue.length) vnc.write(queue.shift()); });
  vnc.on('data', chunk => { if (ws.readyState === 1) ws.send(chunk); });
  vnc.on('error', err => { lastWsEvent = `vnc error ${err.message}`; try { ws.close(); } catch {} });
  vnc.on('close', () => { try { ws.close(); } catch {} });
  ws.on('message', data => { const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data); if (ready) vnc.write(chunk); else queue.push(chunk); });
  ws.on('close', () => { wsClients = Math.max(0, wsClients - 1); vnc.destroy(); });
  ws.on('error', () => vnc.destroy());
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (url.pathname !== '/websockify') return socket.destroy();
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
});
