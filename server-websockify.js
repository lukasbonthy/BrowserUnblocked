'use strict';
const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const { execFile } = require('child_process');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const NOVNC_PORT = Number(process.env.NOVNC_PORT || 6080);
const PORTAL_PASSWORD = process.env.PORTAL_PASSWORD || '';
const VNC_PASSWORD = process.env.VNC_PASSWORD || '';
const CHROME_HOME = process.env.CHROME_HOME || 'https://www.google.com';
const NOVNC_WEB = process.env.NOVNC_WEB || '/usr/share/novnc';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

let lastProxyEvent = 'none yet';
let proxyWsCount = 0;

app.set('trust proxy', 1);
app.use(express.json({ limit: '128kb' }));
app.use(session({ name: 'chromium_portal.sid', secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 8 * 60 * 60 * 1000 } }));

function isAuthed(req) { return !PORTAL_PASSWORD || Boolean(req.session && req.session.authed); }
function requireAuth(req, res, next) { if (isAuthed(req)) return next(); res.status(401).json({ ok: false, error: 'Login required.' }); }
function safeCompare(a, b) { const aa = Buffer.from(String(a || '')); const bb = Buffer.from(String(b || '')); return aa.length === bb.length && crypto.timingSafeEqual(aa, bb); }
function run(command, ms = 7000) { return new Promise((resolve, reject) => { execFile('bash', ['-lc', command], { timeout: ms, env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' } }, (err, out, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(out)); }); }
async function focusChromium() { await run('wid="$(xdotool search --onlyvisible --class chromium 2>/dev/null | head -n 1 || true)"; [ -z "$wid" ] && wid="$(xdotool search --onlyvisible --name Chromium 2>/dev/null | head -n 1 || true)"; [ -n "$wid" ] && xdotool windowactivate --sync "$wid" 2>/dev/null || true').catch(() => ''); }
function normalizeUrl(input) { const raw = String(input || '').trim(); if (!raw) throw new Error('Enter a URL first.'); const parsed = new URL(/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw) ? raw : `https://${raw}`); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http and https URLs are allowed.'); return parsed.toString(); }

app.get('/health', (req, res) => res.json({ ok: true, service: 'chromium-novnc-render-v1.7-websockify-proxy' }));
app.get('/proxy.pac', (req, res) => res.type('application/x-ns-proxy-autoconfig').send('function FindProxyForURL(){return "DIRECT";}'));
app.get('/api/config', (req, res) => { const ok = isAuthed(req); res.json({ ok: true, requiresLogin: Boolean(PORTAL_PASSWORD), authenticated: ok, chromeHome: CHROME_HOME, vnc: ok ? { password: VNC_PASSWORD, path: 'websockify', resize: 'scale' } : null }); });
app.post('/api/login', (req, res) => { if (!PORTAL_PASSWORD || safeCompare(req.body.password, PORTAL_PASSWORD)) { req.session.authed = true; return res.json({ ok: true }); } res.status(401).json({ ok: false, error: 'Wrong portal password.' }); });
app.post('/api/browser/navigate', requireAuth, async (req, res) => { try { const url = normalizeUrl(req.body.url); await focusChromium(); await run(`xdotool key --clearmodifiers ctrl+l && xdotool type --clearmodifiers --delay 1 ${JSON.stringify(url)} && xdotool key --clearmodifiers Return`, 12000); res.json({ ok: true, url }); } catch (err) { res.status(400).json({ ok: false, error: err.message }); } });
app.post('/api/browser/action', requireAuth, async (req, res) => { try { const action = String(req.body.action || '').toLowerCase(); const map = { back: 'Alt_L+Left', forward: 'Alt_L+Right', reload: 'ctrl+r', newtab: 'ctrl+t', fullscreen: 'F11' }; if (action === 'home') { await focusChromium(); await run(`xdotool key --clearmodifiers ctrl+l && xdotool type --clearmodifiers --delay 1 ${JSON.stringify(CHROME_HOME)} && xdotool key --clearmodifiers Return`, 12000); } else { if (!map[action]) throw new Error('Unknown action.'); await focusChromium(); await run(`xdotool key --clearmodifiers ${map[action]}`); } res.json({ ok: true, action }); } catch (err) { res.status(400).json({ ok: false, error: err.message }); } });

app.use('/assets', express.static(path.join(__dirname, 'public'), { maxAge: '0s', etag: false }));
app.use('/novnc', requireAuth, express.static(NOVNC_WEB, { maxAge: '0s', etag: false }));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.get('/api/debug', requireAuth, async (req, res) => { const fs = require('fs'); const read = f => { try { return fs.readFileSync(f, 'utf8').slice(-5000); } catch { return ''; } }; const proc = await run("ps aux | grep -E 'Xvfb|openbox|x11vnc|websockify|chromium|node' | grep -v grep || true", 3000).catch(e => e.message); const win = await run("xdotool search --onlyvisible --name . getwindowname %@ 2>/dev/null || true", 3000).catch(e => e.message); res.type('text/plain').send(['=== build ===', 'server-websockify v1.7', `proxy ws count: ${proxyWsCount}`, `last proxy event: ${lastProxyEvent}`, '=== processes ===', proc, '=== visible windows ===', win, '=== x11vnc.log ===', read('/tmp/x11vnc.log'), '=== websockify.log ===', read('/tmp/websockify.log'), '=== chromium.log ===', read('/tmp/chromium.log')].join('\n')); });

const wsProxy = createProxyMiddleware({ target: `http://127.0.0.1:${NOVNC_PORT}`, changeOrigin: true, ws: true, pathRewrite: { '^/websockify': '' }, on: { proxyReqWs: () => { proxyWsCount += 1; lastProxyEvent = `proxied to websockify ${new Date().toISOString()}`; }, error: err => { lastProxyEvent = `proxy error ${err.message}`; } } });
app.use('/websockify', wsProxy);
const server = app.listen(PORT, () => console.log(`Portal listening on :${PORT}`));
server.on('upgrade', wsProxy.upgrade);
