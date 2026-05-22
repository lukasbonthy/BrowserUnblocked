const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const state = {
  config: null,
  launched: false
};

function setStatus(text, mood = 'neutral') {
  const el = $('#status');
  if (!el) return;
  el.textContent = text;
  el.dataset.mood = mood;
}

function showLogin(show) {
  $('#loginOverlay').classList.toggle('hidden', !show);
  if (show) setTimeout(() => $('#passwordInput')?.focus(), 80);
}

function noVncUrl() {
  const vnc = state.config?.vnc;
  if (!vnc) return '';
  const params = new URLSearchParams({
    autoconnect: '1',
    reconnect: '1',
    resize: vnc.resize || 'scale',
    path: vnc.path || 'websockify',
    password: vnc.password || ''
  });
  return `/novnc/vnc.html?${params.toString()}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

async function loadConfig() {
  state.config = await api('/api/config');

  if (state.config.requiresLogin && !state.config.authenticated) {
    showLogin(true);
    setStatus('Locked', 'warn');
    return;
  }

  showLogin(false);
  setStatus('Ready', 'good');
  $('#urlInput').placeholder = state.config.chromeHome || 'Search or enter a web address';
}

function launch() {
  const src = noVncUrl();
  if (!src) {
    setStatus('Login required', 'warn');
    showLogin(true);
    return;
  }

  $('#hero').classList.add('hidden');
  $('#browserWrap').classList.remove('hidden');
  $('#vncFrame').src = src;
  $('#connectionText').textContent = 'Connected through noVNC';
  state.launched = true;
}

async function handleBrowserAction(action) {
  setStatus(`Sending ${action}…`);
  await api('/api/browser/action', {
    method: 'POST',
    body: JSON.stringify({ action })
  });
  setStatus('Ready', 'good');
}

async function handleNavigate(event) {
  event.preventDefault();
  const url = $('#urlInput').value.trim();
  if (!url) return;
  try {
    setStatus('Navigating…');
    const out = await api('/api/browser/navigate', {
      method: 'POST',
      body: JSON.stringify({ url })
    });
    $('#urlInput').value = out.url || url;
    setStatus('Ready', 'good');
    if (!state.launched) launch();
  } catch (err) {
    setStatus(err.message, 'bad');
  }
}

$('#launchBtn').addEventListener('click', launch);
$('#reconnectBtn').addEventListener('click', () => {
  $('#connectionText').textContent = 'Reconnecting…';
  $('#vncFrame').src = noVncUrl() + `&t=${Date.now()}`;
  setTimeout(() => { $('#connectionText').textContent = 'Connected through noVNC'; }, 700);
});
$('#navForm').addEventListener('submit', handleNavigate);

$$('[data-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    try {
      await handleBrowserAction(button.dataset.action);
      if (!state.launched) launch();
    } catch (err) {
      setStatus(err.message, 'bad');
    }
  });
});

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#loginError').textContent = '';
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: $('#passwordInput').value })
    });
    await loadConfig();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

loadConfig().catch((err) => {
  setStatus(err.message, 'bad');
});
