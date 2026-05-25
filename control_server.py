#!/usr/bin/env python3
import os, sqlite3, secrets, hashlib, html, json, subprocess, shlex, time, re
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse, quote
HOST='127.0.0.1'; PORT=int(os.environ.get('CONTROL_PORT','7070'))
DISPLAY=os.environ.get('APP_DISPLAY',':1'); DNUM=DISPLAY.replace(':','',1); HOME='/home/kasm-user'
STORE=os.environ.get('APP_STORAGE','/app/storage'); DB=os.path.join(STORE,'browserunblocked.db'); PROFILES=os.path.join(STORE,'profiles'); READY='/tmp/browserunblocked-ready'
VIEW='/vnc.html?resize=scale&reconnect=1&autoconnect=1'
for d in (STORE,PROFILES,READY): os.makedirs(d,exist_ok=True)
def sq(x): return shlex.quote(str(x))
def sid(x): return re.sub('[^a-z0-9_-]','',(x or '').lower()) or 'app'
def clean(x): return re.sub('[^a-zA-Z0-9_-]','',(x or '').strip())[:32]
def db():
 c=sqlite3.connect(DB,timeout=15); c.row_factory=sqlite3.Row; return c
def init():
 with db() as c:
  c.execute('create table if not exists users(id integer primary key, name text unique, token text unique, created integer)')
  c.execute('create table if not exists lock(id integer primary key check(id=1), uid integer, name text, app text, seen integer)')
def digest(t): return hashlib.sha256(t.encode()).hexdigest()
def make_user(name):
 token=secrets.token_urlsafe(32)
 with db() as c:
  cur=c.execute('insert into users(name,token,created) values(?,?,?)',(name,digest(token),int(time.time()))); uid=cur.lastrowid
 return uid,token
def jar(h):
 j=cookies.SimpleCookie()
 try: j.load(h or '')
 except Exception: return {}
 return {k:m.value for k,m in j.items()}
def user(h):
 t=jar(h).get('bu_token','')
 if not t: return None
 with db() as c: return c.execute('select * from users where token=?',(digest(t),)).fetchone()
def prof(uid,app):
 p=os.path.join(PROFILES,str(uid),sid(app)); os.makedirs(p,exist_ok=True); return p
def marker(uid,app): return os.path.join(READY,'u%s-%s'%(uid,sid(app)))
def ready(uid,app):
 return {'ok':True,'socketReady':os.path.exists('/tmp/.X11-unix/X'+DNUM),'appReady':os.path.exists(marker(uid,app)),'ready':os.path.exists('/tmp/.X11-unix/X'+DNUM) and os.path.exists(marker(uid,app)),'viewer':VIEW}
def lock(u,app):
 now=int(time.time())
 with db() as c:
  r=c.execute('select * from lock where id=1').fetchone()
  if r and now-int(r['seen'])<1800 and int(r['uid'])!=int(u['id']): return False,'Workspace busy. %s is using it.'%r['name']
  c.execute('insert or replace into lock values(1,?,?,?,?)',(u['id'],u['name'],app,now)); return True,''
def chrome(uid,app,url,mode):
 p=prof(uid,app); flag='--new-window ' if mode=='window' else '--app='
 args='--disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --disable-sync --disable-notifications --disable-background-networking --mute-audio --window-size=960,540 --user-data-dir=%s %s%s'%(sq(p),flag,sq(url))
 return 'mkdir -p %s; B=$(command -v chromium || command -v chromium-browser || command -v google-chrome || true); [ -n "$B" ] && nohup "$B" %s >/tmp/bu-%s-%s.log 2>&1 &'%(sq(p),args,uid,sid(app))
def cmd(uid,app):
 urls={'chromium':('Chromium','https://lite.duckduckgo.com/lite/','window'),'chrome':('Chrome','https://www.google.com/','window'),'firefox':('Firefox','https://www.mozilla.org/firefox/','app'),'discord':('Discord','https://discord.com/app','app'),'brave':('Brave','https://search.brave.com/','app'),'edge':('Edge','https://www.bing.com/','app')}
 if app=='desktop': return 'Desktop',"nohup bash -lc 'xfce4-appfinder || true' >/tmp/bu-desktop.log 2>&1 &"
 if app=='terminal': return 'Terminal',"nohup bash -lc 'x-terminal-emulator || xfce4-terminal || xterm || true' >/tmp/bu-terminal.log 2>&1 &"
 if app not in urls: return '',''
 label,url,mode=urls[app]; return label,chrome(uid,app,url,mode)
def run(uid,app,command):
 m=marker(uid,app)
 script='''export DISPLAY=%s
export HOME=%s
[ -f %s/.Xauthority ] && export XAUTHORITY=%s/.Xauthority || unset XAUTHORITY
rm -f %s
for i in $(seq 1 120); do [ -S /tmp/.X11-unix/X%s ] && break; sleep 1; done
sleep 3
%s
sleep 8
touch %s
'''%(sq(DISPLAY),sq(HOME),sq(HOME),sq(HOME),sq(m),sq(DNUM),command,sq(m))
 env=os.environ.copy(); env['DISPLAY']=DISPLAY; env['HOME']=HOME; env.pop('XAUTHORITY',None)
 subprocess.Popen(['bash','-lc',script],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,stdin=subprocess.DEVNULL,env=env,start_new_session=True)
def page(title,body,u=None):
 nav='<a href=/signup>Sign up</a>' if not u else '<a href=/dashboard>Dashboard</a> <a href=/logout>Logout</a> @'+html.escape(u['name'])
 css='body{font-family:system-ui;background:#070b16;color:white;margin:0}.w{max-width:1100px;margin:auto;padding:28px}a,.btn,button{color:white;background:#4267ff;border:0;border-radius:999px;padding:10px 14px;text-decoration:none;font-weight:800}.card,.app{border:1px solid #ffffff25;background:#ffffff12;border-radius:24px;padding:22px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.app{display:block;background:#ffffff10}input{padding:12px;border-radius:14px;width:100%;box-sizing:border-box;margin:10px 0;background:#0005;color:white;border:1px solid #ffffff33}.err{background:#ff555533;border-radius:14px;padding:10px}@media(max-width:800px){.grid{grid-template-columns:1fr 1fr}}@media(max-width:520px){.grid{grid-template-columns:1fr}}'
 return '<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>%s</title><style>%s</style></head><body><main class=w><p><b>BrowserUnblocked</b> %s</p>%s</main></body></html>'%(html.escape(title),css,nav,body)
def dash(u):
 apps=[('chromium','🌐'),('chrome','🔵'),('firefox','🦊'),('discord','💬'),('brave','🦁'),('edge','🌀'),('desktop','🖥️'),('terminal','⌨️')]
 cards=''.join('<a class=app href=/open/%s><h2>%s %s</h2><p>Opens with your private profile.</p></a>'%(a,i,a.title()) for a,i in apps)
 return page('Dashboard','<section class=card><h1>Welcome, %s</h1><p>Your profiles save under %s/%s/</p><p><a class=btn href="%s">Open current workspace</a></p></section><div class=grid style="margin-top:14px">%s</div>'%(html.escape(u['name']),html.escape(PROFILES),u['id'],VIEW,cards),u)
class H(BaseHTTPRequestHandler):
 def current(self): return user(self.headers.get('Cookie',''))
 def form(self):
  n=int(self.headers.get('Content-Length','0') or 0); return {k:v[0] for k,v in parse_qs(self.rfile.read(n).decode(errors='replace')).items()}
 def sendh(self,code,text,cookie=None,clear=False):
  data=text.encode(); self.send_response(code); self.send_header('Content-Type','text/html; charset=utf-8'); self.send_header('Cache-Control','no-store')
  if cookie: self.send_header('Set-Cookie','bu_token=%s; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000'%cookie)
  if clear: self.send_header('Set-Cookie','bu_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')
  self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
 def redir(self,to,cookie=None,clear=False):
  self.send_response(302); self.send_header('Location',to); self.send_header('Content-Length','0')
  if cookie: self.send_header('Set-Cookie','bu_token=%s; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000'%cookie)
  if clear: self.send_header('Set-Cookie','bu_token=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0')
  self.end_headers()
 def sendj(self,code,obj):
  data=json.dumps(obj).encode(); self.send_response(code); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)
 def do_GET(self):
  p=urlparse(self.path).path.rstrip('/') or '/'; u=self.current()
  if p=='/api/authcheck': self.send_response(204 if u else 401); self.end_headers(); return
  if p=='/health': self.sendj(200,{'ok':True}); return
  if p=='/logout': self.redir('/signup',clear=True); return
  if p=='/signup': self.sendh(200,page('Sign up','<section class=card style="max-width:520px;margin:auto"><h1>Create account</h1><form method=post action=/signup><label>Username</label><input name=name required minlength=3><button>Create account</button></form></section>')); return
  if p in ('/','/apps','/dashboard'): self.sendh(200,dash(u) if u else page('Home','<section class=card><h1>Private cloud app profiles.</h1><p><a class=btn href=/signup>Create account</a></p></section>')); return
  if p.startswith('/api/ready/'): self.sendj(200,ready(u['id'] if u else 0,p.split('/')[-1])); return
  if p.startswith('/open/') or p.startswith('/api/open/'):
   if not u: self.redir('/signup?next='+quote(self.path)); return
   app=sid(p.split('/')[-1]); label,command=cmd(u['id'],app)
   if not command: self.sendj(404,{'ok':False}); return
   ok,msg=lock(u,app)
   if not ok: self.sendh(423,page('Busy','<section class=card><p class=err>%s</p></section>'%html.escape(msg),u)); return
   run(u['id'],app,command); print('control_server: queued %s for %s'%(app,u['name']),flush=True)
   self.sendh(200,page('Opening','<section class=card><h1>Opening %s</h1><p>Waiting for your profile and app window...</p><p><a class=btn href="%s">Open workspace now</a></p></section><script>let t=0;async function c(){t++;let r=await fetch("/api/ready/%s");let d=await r.json();if(d.ready||t>55)location.href=d.viewer;else setTimeout(c,1000)}c()</script>'%(html.escape(label),VIEW,app),u)); return
  self.sendh(404,page('404','<section class=card><h1>Not found</h1></section>',u))
 def do_POST(self):
  if (urlparse(self.path).path.rstrip('/') or '/')!='/signup': self.sendh(404,page('404','not found')); return
  name=clean(self.form().get('name',''))
  if len(name)<3: self.sendh(400,page('Sign up','<section class=card><p class=err>Use 3+ letters.</p></section>')); return
  try:
   uid,t=make_user(name); self.redir('/dashboard',t)
  except sqlite3.IntegrityError: self.sendh(409,page('Sign up','<section class=card><p class=err>Name taken.</p></section>'))
 def log_message(self,fmt,*args): print('control_server:',fmt%args,flush=True)
if __name__=='__main__': init(); print('BrowserUnblocked control server listening on http://%s:%s'%(HOST,PORT),flush=True); print('BrowserUnblocked storage: '+STORE,flush=True); ThreadingHTTPServer((HOST,PORT),H).serve_forever()
