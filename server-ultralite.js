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
const HOME_URL = process.env.CHROME_HOME || 'https://lite.duckduckgo.com/lite/';
const SEARCH_URL = process.env.SEARCH_URL || 'https://lite.duckduckgo.com/lite/?q=';
const WIDTH = Number(process.env.VIEWPORT_WIDTH || 960);
const HEIGHT = Number(process.env.VIEWPORT_HEIGHT || 540);
const QUALITY = Number(process.env.FRAME_QUALITY || 28);
const EVERY_NTH_FRAME = Math.max(1, Number(process.env.FRAME_EVERY_NTH || 4));
const IDLE_MS = Number(process.env.IDLE_MINUTES || 4) * 60_000;
const EMPTY_VIEWER_MS = Number(process.env.EMPTY_VIEWER_SECONDS || 60) * 1000;
const MAX_SESSIONS = Math.max(1, Number(process.env.MAX_SESSIONS || 2));
const MAX_BUFFERED_BYTES = Math.max(128_000, Number(process.env.MAX_BUFFERED_BYTES || 650_000));
const BLOCK_RESOURCE_TYPES = new Set(String(process.env.BLOCK_RESOURCE_TYPES || 'image,font,media').split(',').map(s => s.trim()).filter(Boolean));

const app = express();
app.set('trust proxy', 1);
app.use(compression());
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '64kb' }));

const sessionMiddleware = session({
  name: 'bu.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 6 * 60 * 60 * 1000 }
});
app.use(sessionMiddleware);

let browser;
let launching;
const sessions = new Map();
let totalFrames = 0;
let totalInputs = 0;
let skippedFrames = 0;
let lastError = '';

function authed(req) { return !PORTAL_PASSWORD || !!req.session.authed; }
function requireAuth(req, res, next) { return authed(req) ? next() : res.status(401).json({ ok: false, error: 'Login required.' }); }
function safeCompare(a, b) { const aa = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || '')); return aa.length === bb.length && crypto.timingSafeEqual(aa, bb); }
function sessionId(req) { if (!req.session.cloudSessionId) req.session.cloudSessionId = crypto.randomUUID(); return req.session.cloudSessionId; }
function short(id) { return String(id || '').slice(0, 8); }
function fakeRes() { return { getHeader(){}, setHeader(){}, removeHeader(){}, writeHead(){}, end(){} }; }

function privateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return true;
  const v = net.isIP(h);
  if (!v) return false;
  if (v === 6) return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80:');
  const [a,b] = h.split('.').map(Number);
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0 || a >= 224;
}
async function resolvesPrivate(host) {
  if (privateHost(host)) return true;
  try { return (await dns.lookup(host, { all: true })).some(r => privateHost(r.address)); }
  catch { return false; }
}
function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Enter a URL or search first.');
  const looksLikeUrl = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw) || /^[\w.-]+\.[a-z]{2,}(\/.*)?$/i.test(raw);
  const target = looksLikeUrl ? (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw) ? raw : `https://${raw}`) : `${SEARCH_URL}${encodeURIComponent(raw)}`;
  const u = new URL(target);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https URLs are allowed.');
  if (privateHost(u.hostname)) throw new Error('That address is blocked.');
  return u.toString();
}

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (!launching) launching = chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-sync', '--disable-extensions', '--disable-default-apps', '--disable-background-networking',
      '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--mute-audio',
      '--disable-notifications', '--disable-popup-blocking', '--disable-component-update', '--disable-domain-reliability',
      '--disable-features=TranslateUI,MediaRouter,AutofillServerCommunication,OptimizationHints,InterestFeedContentSuggestions'
    ]
  }).then(b => { browser = b; browser.on('disconnected', () => browser = null); return b; }).finally(() => { launching = null; });
  return launching;
}

async function cleanup() {
  const now = Date.now();
  for (const s of sessions.values()) {
    if (now - s.seen > IDLE_MS || (!s.viewers.size && s.emptyAt && now - s.emptyAt > EMPTY_VIEWER_MS)) await closeSession(s.id).catch(()=>{});
  }
}

async function createCloudSession(id) {
  await cleanup();
  if (sessions.size >= MAX_SESSIONS) throw new Error(`Server is full. ${sessions.size}/${MAX_SESSIONS} sessions are active.`);
  const context = await (await getBrowser()).newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    javaScriptEnabled: true
  });
  await context.route('**/*', async route => {
    const req = route.request();
    try {
      const u = new URL(req.url());
      if (!['http:', 'https:', 'data:', 'blob:', 'about:'].includes(u.protocol)) return route.abort('blockedbyclient');
      if (['http:', 'https:'].includes(u.protocol) && await resolvesPrivate(u.hostname)) return route.abort('blockedbyclient');
      if (BLOCK_RESOURCE_TYPES.has(req.resourceType())) return route.abort('blockedbyclient');
    } catch { return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(25000);
  const client = await context.newCDPSession(page);
  await client.send('Page.enable');
  const s = { id, context, page, client, viewers: new Set(), seen: Date.now(), emptyAt: Date.now(), frames: 0, inputs: 0, casting: false, handler: false, url: HOME_URL, title: 'Cloud Chromium' };
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) { s.url = page.url(); sendState(s).catch(()=>{}); } });
  page.on('close', () => closeSession(id).catch(()=>{}));
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(()=>{});
  sessions.set(id, s);
  return s;
}
async function currentSession(req) { const id = sessionId(req); let s = sessions.get(id); if (!s) s = await createCloudSession(id); s.seen = Date.now(); return s; }

async function startCast(s) {
  if (!s.handler) {
    s.handler = true;
    s.client.on('Page.screencastFrame', async ev => {
      totalFrames++; s.frames++;
      if (s.viewers.size) {
        const msg = JSON.stringify({ type: 'frame', data: ev.data, width: WIDTH, height: HEIGHT });
        for (const ws of s.viewers) {
          if (ws.readyState !== 1) continue;
          if (ws.bufferedAmount > MAX_BUFFERED_BYTES) { skippedFrames++; continue; }
          ws.send(msg);
        }
      }
      await s.client.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(()=>{});
    });
  }
  if (s.casting) return;
  s.casting = true;
  await s.client.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: EVERY_NTH_FRAME });
}
async function stopCast(s) { if (s && s.casting) { s.casting = false; await s.client.send('Page.stopScreencast').catch(()=>{}); } }
async function sendState(s) {
  s.title = await s.page.title().catch(() => s.title);
  const msg = JSON.stringify({ type: 'state', url: s.page.url(), title: s.title, sessionId: short(s.id), activeSessions: sessions.size, maxSessions: MAX_SESSIONS });
  for (const ws of s.viewers) if (ws.readyState === 1) ws.send(msg);
}
async function closeSession(id) {
  const s = sessions.get(id); if (!s) return;
  sessions.delete(id);
  for (const ws of s.viewers) try { ws.close(); } catch {}
  await s.context.close().catch(()=>{});
}
async function input(s, msg) {
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
    if (msg.event === 'text' && msg.text) return s.page.keyboard.insertText(String(msg.text).slice(0, 140));
    if (msg.event === 'press' && msg.key) return s.page.keyboard.press(String(msg.key));
  }
}

app.get('/health', (req, res) => res.json({ ok: true, service: 'browserunblocked-cdp-ultralite', sessions: sessions.size, maxSessions: MAX_SESSIONS, viewport: `${WIDTH}x${HEIGHT}`, quality: QUALITY, everyNthFrame: EVERY_NTH_FRAME }));
app.get('/api/config', (req, res) => res.json({ ok: true, requiresLogin: !!PORTAL_PASSWORD, authenticated: authed(req), sessionId: short(sessionId(req)), sessions: sessions.size, maxSessions: MAX_SESSIONS, viewport: { width: WIDTH, height: HEIGHT } }));
app.post('/api/login', (req, res) => { sessionId(req); if (!PORTAL_PASSWORD || safeCompare(req.body.password, PORTAL_PASSWORD)) { req.session.authed = true; return req.session.save(() => res.json({ ok: true, sessionId: short(req.session.cloudSessionId) })); } res.status(401).json({ ok: false, error: 'Wrong password.' }); });
app.post('/api/navigate', requireAuth, async (req, res) => { try { const url = normalizeUrl(req.body.url); const s = await currentSession(req); await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 }); await sendState(s); res.json({ ok: true, url: s.page.url(), sessionId: short(s.id) }); } catch (e) { lastError = e.message; res.status(400).json({ ok: false, error: e.message }); } });
app.post('/api/action', requireAuth, async (req, res) => { try { const s = await currentSession(req); const a = String(req.body.action || ''); if (a === 'back') await s.page.goBack({ timeout: 8000 }).catch(()=>{}); else if (a === 'forward') await s.page.goForward({ timeout: 8000 }).catch(()=>{}); else if (a === 'reload') await s.page.reload({ timeout: 10000 }).catch(()=>{}); else if (a === 'home') await s.page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }); else throw new Error('Unknown action.'); await sendState(s); res.json({ ok: true, sessionId: short(s.id) }); } catch (e) { lastError = e.message; res.status(400).json({ ok: false, error: e.message }); } });
app.get('/api/debug', requireAuth, (req, res) => res.json({ ok: true, currentSession: short(sessionId(req)), settings: { width: WIDTH, height: HEIGHT, quality: QUALITY, everyNthFrame: EVERY_NTH_FRAME, maxSessions: MAX_SESSIONS, blockResourceTypes: [...BLOCK_RESOURCE_TYPES] }, sessions: [...sessions.values()].map(s => ({ id: short(s.id), viewers: s.viewers.size, casting: s.casting, frames: s.frames, inputs: s.inputs, url: s.url, idleSec: Math.round((Date.now() - s.seen)/1000) })), totalFrames, totalInputs, skippedFrames, lastError }));
app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '0s', etag: false }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

const server = app.listen(PORT, '0.0.0.0', () => console.log(`BrowserUnblocked ultralite listening on ${PORT}`));
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on('upgrade', (req, socket, head) => { if (!req.url.startsWith('/stream')) return socket.destroy(); sessionMiddleware(req, fakeRes(), () => { if (!authed(req)) return socket.destroy(); wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); }); });
wss.on('connection', async (ws, req) => { let s; try { s = await currentSession(req); s.viewers.add(ws); s.emptyAt = 0; await startCast(s); await sendState(s); ws.send(JSON.stringify({ type: 'ready', width: WIDTH, height: HEIGHT, sessionId: short(s.id), activeSessions: sessions.size, maxSessions: MAX_SESSIONS })); } catch (e) { lastError = e.message; try { ws.send(JSON.stringify({ type: 'error', error: e.message })); } catch {} return ws.close(); } ws.on('message', async raw => { try { await input(s, JSON.parse(String(raw))); } catch (e) { lastError = e.message; } }); ws.on('close', () => { if (!s) return; s.viewers.delete(ws); if (!s.viewers.size) { s.emptyAt = Date.now(); stopCast(s).catch(()=>{}); } }); });
setInterval(() => cleanup().catch(()=>{}), 30000).unref();
process.on('SIGTERM', async () => { for (const id of [...sessions.keys()]) await closeSession(id).catch(()=>{}); if (browser) await browser.close().catch(()=>{}); process.exit(0); });
