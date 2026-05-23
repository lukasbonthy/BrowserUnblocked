'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const path = require('path');
const express = require('express');
const session = require('express-session');
const compression = require('compression');
const helmet = require('helmet');
const { WebSocketServer } = require('ws');
const { chromium } = require('playwright');

const PORT = Number(process.env.PORT || 10000);
const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const HOME_URL = process.env.CHROME_HOME || 'https://www.google.com';
const WIDTH = Number(process.env.VIEWPORT_WIDTH || 1365);
const HEIGHT = Number(process.env.VIEWPORT_HEIGHT || 768);
const IDLE_MS = Number(process.env.IDLE_MINUTES || 10) * 60_000;
const QUALITY = Number(process.env.FRAME_QUALITY || 64);

const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '256kb' }));

const sessionMiddleware = session({
  name: 'bu.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 8 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);

let browser;
let launching;
const cloudSessions = new Map();
let totalFrames = 0;
let totalInputs = 0;
let lastError = '';

function authed(req) { return !PORTAL_PASSWORD || !!req.session.authed; }
function requireAuth(req, res, next) { return authed(req) ? next() : res.status(401).json({ ok: false, error: 'Login required.' }); }
function safeCompare(a, b) { const aa = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || '')); return aa.length === bb.length && crypto.timingSafeEqual(aa, bb); }

function blockedHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return true;
  if (h === 'metadata.google.internal' || h === '169.254.169.254') return true;
  const ipver = net.isIP(h);
  if (!ipver) return false;
  if (ipver === 6) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:');
  const [a,b] = h.split('.').map(Number);
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0 || a >= 224;
}

async function resolvesBlocked(host) {
  if (blockedHost(host)) return true;
  try { const rows = await dns.lookup(host, { all: true }); return rows.some(r => blockedHost(r.address)); }
  catch { return false; }
}

function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter a URL first.');
  const u = new URL(/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw) ? raw : `https://${raw}`);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https URLs are allowed.');
  if (blockedHost(u.hostname)) throw new Error('Local/private URLs are blocked.');
  return u.toString();
}

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (!launching) launching = chromium.launch({ headless: true, args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-default-browser-check'] }).then(b => { browser = b; browser.on('disconnected', () => browser = null); return b; }).finally(() => launching = null);
  return launching;
}

async function makeSession(id) {
  const b = await getBrowser();
  const context = await b.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await context.route('**/*', async route => {
    try {
      const u = new URL(route.request().url());
      if (['http:', 'https:'].includes(u.protocol) && await resolvesBlocked(u.hostname)) return route.abort('blockedbyclient');
      if (!['http:', 'https:', 'data:', 'blob:', 'about:'].includes(u.protocol)) return route.abort('blockedbyclient');
    } catch { return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const page = await context.newPage();
  const client = await context.newCDPSession(page);
  await client.send('Page.enable');
  const s = { id, context, page, client, viewers: new Set(), seen: Date.now(), frames: 0, inputs: 0, casting: false, url: HOME_URL, title: 'Cloud Chromium' };
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) { s.url = page.url(); sendState(s).catch(()=>{}); } });
  page.on('close', () => closeSession(id).catch(()=>{}));
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
  cloudSessions.set(id, s);
  return s;
}

async function sessionFor(id) {
  let s = cloudSessions.get(id);
  if (!s) s = await makeSession(id);
  s.seen = Date.now();
  return s;
}

async function startCast(s) {
  if (s.casting) return;
  s.casting = true;
  s.client.on('Page.screencastFrame', async ev => {
    totalFrames++; s.frames++;
    const msg = JSON.stringify({ type: 'frame', data: ev.data, width: WIDTH, height: HEIGHT });
    for (const ws of s.viewers) if (ws.readyState === ws.OPEN) ws.send(msg);
    await s.client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(()=>{});
  });
  await s.client.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
}

async function sendState(s) {
  s.title = await s.page.title().catch(() => s.title);
  const msg = JSON.stringify({ type: 'state', url: s.page.url(), title: s.title });
  for (const ws of s.viewers) if (ws.readyState === ws.OPEN) ws.send(msg);
}

async function closeSession(id) {
  const s = cloudSessions.get(id); if (!s) return;
  cloudSessions.delete(id);
  for (const ws of s.viewers) try { ws.close(); } catch {}
  await s.context.close().catch(()=>{});
}

async function handleInput(s, msg) {
  s.seen = Date.now(); s.inputs++; totalInputs++;
  if (msg.kind === 'mouse') {
    const x = Math.max(0, Math.min(WIDTH, Number(msg.x || 0)));
    const y = Math.max(0, Math.min(HEIGHT, Number(msg.y || 0)));
    if (msg.event === 'move') return s.page.mouse.move(x, y);
    if (msg.event === 'down') return s.page.mouse.down({ button: msg.button || 'left' });
    if (msg.event === 'up') return s.page.mouse.up({ button: msg.button || 'left' });
    if (msg.event === 'click') return s.page.mouse.click(x, y, { button: msg.button || 'left' });
    if (msg.event === 'wheel') return s.page.mouse.wheel(Number(msg.deltaX || 0), Number(msg.deltaY || 0));
  }
  if (msg.kind === 'key') {
    if (msg.event === 'text' && msg.text) return s.page.keyboard.insertText(String(msg.text).slice(0, 200));
    if (msg.event === 'press' && msg.key) return s.page.keyboard.press(String(msg.key));
  }
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'browserunblocked-cdp-v2', sessions: cloudSessions.size }));
app.get('/api/config', (req, res) => res.json({ ok: true, requiresLogin: !!PORTAL_PASSWORD, authenticated: authed(req), viewport: { width: WIDTH, height: HEIGHT } }));
app.post('/api/login', (req, res) => { if (!PORTAL_PASSWORD || safeCompare(req.body.password, PORTAL_PASSWORD)) { req.session.authed = true; return res.json({ ok: true }); } res.status(401).json({ ok: false, error: 'Wrong password.' }); });
app.post('/api/navigate', requireAuth, async (req, res) => { try { const url = normalizeUrl(req.body.url); const s = await sessionFor(req.sessionID); await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); await sendState(s); res.json({ ok: true, url: s.page.url() }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });
app.post('/api/action', requireAuth, async (req, res) => { try { const s = await sessionFor(req.sessionID); const a = String(req.body.action || ''); if (a === 'back') await s.page.goBack({ timeout: 15000 }).catch(()=>{}); else if (a === 'forward') await s.page.goForward({ timeout: 15000 }).catch(()=>{}); else if (a === 'reload') await s.page.reload({ timeout: 15000 }).catch(()=>{}); else if (a === 'home') await s.page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }); else throw new Error('Unknown action.'); await sendState(s); res.json({ ok: true }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); } });
app.get('/api/debug', requireAuth, (req, res) => res.json({ ok: true, sessions: [...cloudSessions.values()].map(s => ({ viewers: s.viewers.size, frames: s.frames, inputs: s.inputs, url: s.url, idleSec: Math.round((Date.now() - s.seen)/1000) })), totalFrames, totalInputs, lastError }));
app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

const server = app.listen(PORT, '0.0.0.0', () => console.log(`BrowserUnblocked CDP v2 listening on ${PORT}`));
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => { if (!req.url.startsWith('/stream')) return socket.destroy(); sessionMiddleware(req, {}, () => { if (!authed(req)) return socket.destroy(); wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); }); });
wss.on('connection', async (ws, req) => { let s; try { s = await sessionFor(req.sessionID); s.viewers.add(ws); await startCast(s); await sendState(s); ws.send(JSON.stringify({ type: 'ready', width: WIDTH, height: HEIGHT })); } catch (e) { lastError = e.message; try { ws.send(JSON.stringify({ type: 'error', error: e.message })); } catch {} return ws.close(); } ws.on('message', async raw => { try { await handleInput(s, JSON.parse(String(raw))); } catch (e) { lastError = e.message; } }); ws.on('close', () => s && s.viewers.delete(ws)); });
setInterval(() => { const now = Date.now(); for (const s of cloudSessions.values()) if (now - s.seen > IDLE_MS) closeSession(s.id).catch(()=>{}); }, 60000).unref();
process.on('SIGTERM', async () => { for (const id of [...cloudSessions.keys()]) await closeSession(id).catch(()=>{}); if (browser) await browser.close().catch(()=>{}); process.exit(0); });
