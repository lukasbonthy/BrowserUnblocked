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
const timeout = require('connect-timeout');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const NOVNC_PORT = Number(process.env.NOVNC_PORT || 6080);
const VNC_PASSWORD = process.env.VNC_PASSWORD || '';
const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || '';
const CHROME_HOME = process.env.CHROME_HOME || 'https://www.google.com';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const NOVNC_WEB = process.env.NOVNC_WEB || '/usr/share/novnc';

app.set('trust proxy', 1);

app.use(timeout('20s'));
app.use(compression());
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-site' }
}));
app.use(express.json({ limit: '128kb' }));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));
app.use(cookieParser());

const sessionMiddleware = session({
  name: 'chromium_portal.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: 'auto',
    maxAge: 8 * 60 * 60 * 1000
  }
});
app.use(sessionMiddleware);

function isAuthed(req) {
  return !PORTAL_PASSWORD || Boolean(req.session && req.session.authed === true);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ ok: false, error: 'Login required.' });
}

function safeCompare(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function haltOnTimedout(req, res, next) {
  if (!req.timedout) next();
}

function isPrivateIp(ip) {
  const version = net.isIP(ip);
  if (!version) return false;

  if (version === 6) {
    const v = ip.toLowerCase();
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:');
  }

  const parts = ip.split('.').map(Number);
  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 0) ||
    (a >= 224)
  );
}

function isBlockedHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return (
    !h ||
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h.endsWith('.lan') ||
    h === 'metadata.google.internal' ||
    h === '169.254.169.254' ||
    isPrivateIp(h)
  );
}

function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter a URL first.');

  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withScheme);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are allowed.');
  }
  if (isBlockedHost(parsed.hostname)) {
    throw new Error('Local/private network URLs are blocked in this v1 portal.');
  }
  return parsed.toString();
}

function runXd(args, ms = 5000) {
  return new Promise((resolve, reject) => {
    execFile('xdotool', args, {
      timeout: ms,
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' }
    }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.message}${stderr ? `\n${stderr}` : ''}`;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

function runShell(command, ms = 5000) {
  return new Promise((resolve, reject) => {
    execFile('bash', ['-lc', command], {
      timeout: ms,
      env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' }
    }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.message}${stderr ? `\n${stderr}` : ''}`;
        reject(err);
      } else {
        resolve(stdout);
      }
    });
  });
}

async function focusChromium() {
  await runShell("xdotool search --onlyvisible --class chromium windowactivate --sync 2>/dev/null || xdotool search --onlyvisible --name Chromium windowactivate --sync 2>/dev/null || true", 3000);
}

async function navigate(url) {
  await focusChromium();
  await runXd(['key', '--clearmodifiers', 'ctrl+l']);
  await runXd(['type', '--clearmodifiers', '--delay', '1', url], 10000);
  await runXd(['key', '--clearmodifiers', 'Return']);
}

async function browserAction(action) {
  await focusChromium();
  const actions = {
    back: ['key', '--clearmodifiers', 'Alt_L+Left'],
    forward: ['key', '--clearmodifiers', 'Alt_L+Right'],
    reload: ['key', '--clearmodifiers', 'ctrl+r'],
    stop: ['key', '--clearmodifiers', 'Escape'],
    newtab: ['key', '--clearmodifiers', 'ctrl+t'],
    closetab: ['key', '--clearmodifiers', 'ctrl+w'],
    fullscreen: ['key', '--clearmodifiers', 'F11']
  };
  if (!actions[action]) throw new Error('Unknown action.');
  await runXd(actions[action]);
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'chromium-novnc-portal-v1' });
});

app.get('/proxy.pac', (req, res) => {
  res.type('application/x-ns-proxy-autoconfig').send(`
function FindProxyForURL(url, host) {
  var h = host.toLowerCase();
  if (url.substring(0, 5) === 'file:') return 'PROXY 0.0.0.0:9';
  if (h === 'localhost' || dnsDomainIs(h, '.localhost') || dnsDomainIs(h, '.local') || dnsDomainIs(h, '.internal') || dnsDomainIs(h, '.lan')) return 'PROXY 0.0.0.0:9';
  if (h === 'metadata.google.internal' || h === '169.254.169.254') return 'PROXY 0.0.0.0:9';
  if (isPlainHostName(h)) return 'PROXY 0.0.0.0:9';

  var ip = dnsResolve(host);
  if (!ip) return 'DIRECT';
  if (isInNet(ip, '0.0.0.0', '255.0.0.0')) return 'PROXY 0.0.0.0:9';
  if (isInNet(ip, '10.0.0.0', '255.0.0.0')) return 'PROXY 0.0.0.0:9';
  if (isInNet(ip, '127.0.0.0', '255.0.0.0')) return 'PROXY 0.0.0.0:9';
  if (isInNet(ip, '169.254.0.0', '255.255.0.0')) return 'PROXY 0.0.0.0:9';
  if (isInNet(ip, '172.16.0.0', '255.240.0.0')) return 'PROXY 0.0.0.0:9';
  if (isInNet(ip, '192.168.0.0', '255.255.0.0')) return 'PROXY 0.0.0.0:9';
  return 'DIRECT';
}
`);
});

app.get('/api/config', (req, res) => {
  const authed = isAuthed(req);
  res.json({
    ok: true,
    requiresLogin: Boolean(PORTAL_PASSWORD),
    authenticated: authed,
    chromeHome: CHROME_HOME,
    vnc: authed ? {
      password: VNC_PASSWORD,
      path: 'websockify',
      autoconnect: true,
      resize: 'scale'
    } : null
  });
});

app.post('/api/login', (req, res) => {
  if (!PORTAL_PASSWORD) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  if (!safeCompare(req.body.password, PORTAL_PASSWORD)) {
    return res.status(401).json({ ok: false, error: 'Wrong portal password.' });
  }
  req.session.authed = true;
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.post('/api/browser/navigate', requireAuth, haltOnTimedout, async (req, res) => {
  try {
    const url = normalizeUrl(req.body.url);
    await navigate(url);
    res.json({ ok: true, url });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'Navigation failed.' });
  }
});

app.post('/api/browser/action', requireAuth, haltOnTimedout, async (req, res) => {
  try {
    const action = String(req.body.action || '').toLowerCase();
    if (action === 'home') {
      const url = normalizeUrl(CHROME_HOME);
      await navigate(url);
      return res.json({ ok: true, action, url });
    }
    await browserAction(action);
    res.json({ ok: true, action });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'Action failed.' });
  }
});

app.use('/assets', express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true
}));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/novnc', requireAuth, express.static(NOVNC_WEB, {
  maxAge: '1h',
  etag: true
}));

const noVncProxy = createProxyMiddleware({
  target: `http://127.0.0.1:${NOVNC_PORT}`,
  changeOrigin: true,
  ws: true,
  logLevel: 'warn',
  pathRewrite: { '^/websockify': '' }
});

app.use('/websockify', noVncProxy);



app.get('/api/debug', requireAuth, async (req, res) => {
  try {
    const fs = require('fs');
    const read = (file) => {
      try { return fs.readFileSync(file, 'utf8').slice(-4000); }
      catch { return ''; }
    };
    const processes = await runShell("ps aux | grep -E 'Xvfb|openbox|x11vnc|websockify|chromium' | grep -v grep || true", 3000);
    res.type('text/plain').send([
      '=== processes ===',
      processes,
      '=== xvfb.log ===', read('/tmp/xvfb.log'),
      '=== x11vnc.log ===', read('/tmp/x11vnc.log') || read('/tmp/x11vnc.stdout.log'),
      '=== websockify.log ===', read('/tmp/websockify.log'),
      '=== chromium.log ===', read('/tmp/chromium.log'),
      '=== openbox.log ===', read('/tmp/openbox.log')
    ].join('\n'));
  } catch (err) {
    res.status(500).type('text/plain').send(err.message || String(err));
  }
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found.' });
});

app.use((err, req, res, next) => {
  if (req.timedout) return;
  console.error(err);
  res.status(500).json({ ok: false, error: 'Server error.' });
});

const server = app.listen(PORT, () => {
  console.log(`Chromium noVNC portal listening on :${PORT}`);
});

server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/websockify')) {
    noVncProxy.upgrade(req, socket, head);
  } else {
    socket.destroy();
  }
});
