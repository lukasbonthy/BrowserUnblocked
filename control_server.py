#!/usr/bin/env python3
import os, sqlite3, secrets, hashlib, html, json, subprocess, shlex, time, re, signal
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse, quote

HOST='127.0.0.1'; PORT=int(os.environ.get('CONTROL_PORT','7070'))
STORE=os.environ.get('APP_STORAGE','/app/storage')
DB=os.path.join(STORE,'browserunblocked.db')
PROFILES=os.path.join(STORE,'profiles')
HOMES=os.path.join(STORE,'homes')
NGINX_DIR='/tmp/browserunblocked-nginx'
MAX_SESSIONS=int(os.environ.get('MAX_ACTIVE_SESSIONS','3'))
BASE_DISPLAY=int(os.environ.get('BASE_DISPLAY','30'))
BASE_WEB_PORT=int(os.environ.get('BASE_WEB_PORT','7300'))
BASE_VNC_PORT=int(os.environ.get('BASE_VNC_PORT','5900'))
RES=os.environ.get('VNC_RESOLUTION','960x540')
for d in (STORE,PROFILES,HOMES,NGINX_DIR): os.makedirs(d,exist_ok=True)

def sq(x): return shlex.quote(str(x))
def sid(x): return re.sub('[^a-z0-9_-]','',(x or '').lower()) or 'app'
def clean(x): return re.sub('[^a-zA-Z0-9_-]','',(x or '').strip())[:32]
def db():
 c=sqlite3.connect(DB,timeout=15); c.row_factory=sqlite3.Row; return c
def init():
 with db() as c:
  c.execute('create table if not exists users(id integer primary key, name text unique, token text unique, created integer)')
  c.execute('create table if not exists sessions(id integer primary key, uid integer unique, route text unique, display integer, web_port integer, vnc_port integer, pid integer, app text, created integer, seen integer)')
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
def alive(pid):
 try:
  if not pid: return False
  os.kill(int(pid),0); return True
 except Exception: return False
def active_count():
 with db() as c: rows=c.execute('select pid from sessions').fetchall()
 return sum(1 for r in rows if alive(r['pid']))
def profile(uid,app):
 p=os.path.join(PROFILES,str(uid),sid(app)); os.makedirs(p,exist_ok=True); return p
def home(uid):
 h=os.path.join(HOMES,str(uid)); os.makedirs(os.path.join(h,'.vnc'),exist_ok=True); return h
def route_conf(route,port):
 return os.path.join(NGINX_DIR,'session_%s.conf'%route)
def viewer(route): return '/s/%s/vnc.html?resize=scale&reconnect=1&autoconnect=1'%route
def app_url(app):
 return {'chromium':'https://lite.duckduckgo.com/lite/','chrome':'https://www.google.com/','firefox':'https://www.mozilla.org/firefox/','discord':'https://discord.com/app','brave':'https://search.brave.com/','edge':'https://www.bing.com/'}.get(app,'https://lite.duckduckgo.com/lite/')
def label(app): return {'chromium':'Chromium','chrome':'Chrome','firefox':'Firefox','discord':'Discord','brave':'Brave','edge':'Edge','desktop':'Desktop','terminal':'Terminal'}.get(app,app.title())
def write_kasm_config(uid,web_port):
 h=home(uid)
 w,hgt=(RES.split('x')+['540'])[:2]
 cfg=f'''desktop:\n  resolution:\n    width: {w}\n    height: {hgt}\n  allow_resize: false\n  pixel_depth: 16\nnetwork:\n  protocol: http\n  interface: 0.0.0.0\n  websocket_port: {web_port}\n  use_ipv4: true\n  use_ipv6: false\n  ssl:\n    require_ssl: true\nuser_session:\n  session_type: exclusive\n  idle_timeout: never\nruntime_configuration:\n  allow_client_to_override_kasm_server_settings: false\n  allow_override_standard_vnc_server_settings: false\nlogging:\n  log_writer_name: all\n  log_dest: logfile\n  level: 0\nsecurity:\n  brute_force_protection:\n    blacklist_threshold: 0\n    blacklist_timeout: 1\nencoding:\n  max_frame_rate: 18\n  full_frame_updates: none\n  rect_encoding_mode:\n    min_quality: 3\n    max_quality: 5\n    rectangle_compress_threads: auto\n  video_encoding_mode:\n    jpeg_quality: 4\n    webp_quality: 4\n    max_resolution:\n      width: {w}\n      height: {hgt}\n    enter_video_encoding_mode:\n      time_threshold: 2\n      area_threshold: 35%\n    exit_video_encoding_mode:\n      time_threshold: 1\n    logging:\n      level: off\n  compare_framebuffer: auto\n  zrle_zlib_level: 1\n  hextile_improved_compression: false\nkeyboard:\n  remap_keys:\n'''
 open(os.path.join(h,'.vnc','kasmvnc.yaml'),'w').write(cfg)
def write_nginx(route,web_port):
 conf=f'''location ^~ /s/{route}/ {{\n    auth_request /authcheck;\n    proxy_pass https://127.0.0.1:{web_port}/;\n    proxy_ssl_verify off;\n    proxy_ssl_server_name off;\n    proxy_http_version 1.1;\n    proxy_set_header Host $host;\n    proxy_set_header X-Real-IP $remote_addr;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_set_header X-Forwarded-Proto https;\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";\n}}\n'''
 open(route_conf(route,web_port),'w').write(conf)
 subprocess.run(['nginx','-s','reload'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
def start_kasm(uid,app,display,web_port,vnc_port):
 h=home(uid); p=profile(uid,app); write_kasm_config(uid,web_port)
 env=os.environ.copy(); env.update({'DISPLAY':':%s'%display,'HOME':h,'USER':'kasm-user','VNC_PORT':str(vnc_port),'NO_VNC_PORT':str(web_port),'VNC_RESOLUTION':RES,'LAUNCH_URL':app_url(app),'APP_ARGS':'--disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check --disable-sync --disable-notifications --disable-background-networking --mute-audio --window-size=%s --user-data-dir=%s'%(RES.replace('x',','),p)})
 cmd='/dockerstartup/kasm_default_profile.sh /dockerstartup/vnc_startup.sh /dockerstartup/custom_startup.sh --wait'
 log=open('/tmp/bu-session-%s.log'%uid,'ab',buffering=0)
 return subprocess.Popen(['bash','-lc',cmd],env=env,stdout=log,stderr=log,stdin=subprocess.DEVNULL,start_new_session=True).pid
def get_session(uid):
 with db() as c: return c.execute('select * from sessions where uid=?',(uid,)).fetchone()
def ensure_session(u,app):
 uid=int(u['id']); s=get_session(uid); now=int(time.time())
 if s and alive(s['pid']):
  with db() as c: c.execute('update sessions set app=?,seen=? where uid=?',(app,now,uid))
  return dict(s)
 if active_count()>=MAX_SESSIONS: raise RuntimeError('All private sessions are busy. Try again after someone closes theirs.')
 old_route=s['route'] if s else secrets.token_urlsafe(8).replace('-','').replace('_','')
 display=BASE_DISPLAY+uid; web_port=BASE_WEB_PORT+uid; vnc_port=BASE_VNC_PORT+uid
 pid=start_kasm(uid,app,display,web_port,vnc_port); write_nginx(old_route,web_port)
 with db() as c:
  c.execute('insert or replace into sessions(uid,route,display,web_port,vnc_port,pid,app,created,seen) values(?,?,?,?,?,?,?,?,?)',(uid,old_route,display,web_port,vnc_port,pid,app,now,now))
 return {'uid':uid,'route':old_route,'display':display,'web_port':web_port,'vnc_port':vnc_port,'pid':pid,'app':app,'created':now,'seen':now}
def stop_session(uid):
 s=get_session(uid)
 if s:
  try: os.killpg(os.getpgid(int(s['pid'])),signal.SIGTERM)
  except Exception: pass
  try: os.remove(route_conf(s['route'],s['web_port']))
  except Exception: pass
  with db() as c: c.execute('delete from sessions where uid=?',(uid,))
  subprocess.run(['nginx','-s','reload'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
def ready(uid,app):
 s=get_session(uid); ok=bool(s and alive(s['pid'])); sock=False
 if s: sock=os.path.exists('/tmp/.X11-unix/X%s'%s['display'])
 return {'ok':True,'socketReady':sock,'appReady':ok,'ready':sock and ok,'viewer':viewer(s['route']) if s else '/dashboard'}
def page(title,body,u=None):
 nav='<a href=/signup>Sign up</a>' if not u else '<a href=/dashboard>Dashboard</a> <a href=/release>End session</a> <a href=/logout>Logout</a> @'+html.escape(u['name'])
 css='body{font-family:system-ui;background:#070b16;color:white;margin:0}.w{max-width:1100px;margin:auto;padding:28px}a,.btn,button{color:white;background:#4267ff;border:0;border-radius:999px;padding:10px 14px;text-decoration:none;font-weight:800}.card,.app{border:1px solid #ffffff25;background:#ffffff12;border-radius:24px;padding:22px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.app{display:block;background:#ffffff10}input{padding:12px;border-radius:14px;width:100%;box-sizing:border-box;margin:10px 0;background:#0005;color:white;border:1px solid #ffffff33}.err{background:#ff555533;border-radius:14px;padding:10px}@media(max-width:800px){.grid{grid-template-columns:1fr 1fr}}@media(max-width:520px){.grid{grid-template-columns:1fr}}'
 return '<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>%s</title><style>%s</style></head><body><main class=w><p><b>BrowserUnblocked</b> %s</p>%s</main></body></html>'%(html.escape(title),css,nav,body)
def dash(u):
 s=get_session(int(u['id'])); openlink=viewer(s['route']) if s and alive(s['pid']) else '/open/chromium'
 apps=[('chromium','🌐'),('chrome','🔵'),('firefox','🦊'),('discord','💬'),('brave','🦁'),('edge','🌀'),('desktop','🖥️'),('terminal','⌨️')]
 cards=''.join('<a class=app href=/open/%s><h2>%s %s</h2><p>Starts your own private KasmVNC session.</p></a>'%(a,i,a.title()) for a,i in apps)
 return page('Dashboard','<section class=card><h1>Welcome, %s</h1><p>Each account now gets its own KasmVNC desktop on its own internal port.</p><p><a class=btn href="%s">Open current session</a> <a class=btn href=/release>End session</a></p></section><div class=grid style="margin-top:14px">%s</div>'%(html.escape(u['name']),openlink,cards),u)
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
  if p=='/release':
   if u: stop_session(int(u['id']))
   self.redir('/dashboard'); return
  if p=='/logout':
   if u: stop_session(int(u['id']))
   self.redir('/signup',clear=True); return
  if p=='/signup': self.sendh(200,page('Sign up','<section class=card style="max-width:520px;margin:auto"><h1>Create account</h1><form method=post action=/signup><label>Username</label><input name=name required minlength=3><button>Create account</button></form></section>')); return
  if p in ('/','/apps','/dashboard'): self.sendh(200,dash(u) if u else page('Home','<section class=card><h1>Private KasmVNC sessions.</h1><p><a class=btn href=/signup>Create account</a></p></section>')); return
  if p.startswith('/api/ready/'): self.sendj(200,ready(int(u['id']) if u else 0,p.split('/')[-1])); return
  if p.startswith('/open/'):
   if not u: self.redir('/signup?next='+quote(self.path)); return
   app=sid(p.split('/')[-1])
   try: s=ensure_session(u,app)
   except Exception as e: self.sendh(503,page('Busy','<section class=card><p class=err>%s</p></section>'%html.escape(str(e)),u)); return
   print('control_server: private session %s for %s on port %s'%(s['route'],u['name'],s['web_port']),flush=True)
   self.sendh(200,page('Opening','<section class=card><h1>Opening %s</h1><p>Starting your private KasmVNC session...</p><p><a class=btn href="%s">Open now</a></p></section><script>let t=0;async function c(){t++;let r=await fetch("/api/ready/%s");let d=await r.json();if(d.ready||t>70)location.href=d.viewer;else setTimeout(c,1000)}c()</script>'%(html.escape(label(app)),viewer(s['route']),app),u)); return
  self.sendh(404,page('404','<section class=card><h1>Not found</h1></section>',u))
 def do_POST(self):
  if (urlparse(self.path).path.rstrip('/') or '/')!='/signup': self.sendh(404,page('404','not found')); return
  name=clean(self.form().get('name',''))
  if len(name)<3: self.sendh(400,page('Sign up','<section class=card><p class=err>Use 3+ letters.</p></section>')); return
  try:
   uid,t=make_user(name); self.redir('/dashboard',t)
  except sqlite3.IntegrityError: self.sendh(409,page('Sign up','<section class=card><p class=err>Name taken.</p></section>'))
 def log_message(self,fmt,*args): print('control_server:',fmt%args,flush=True)
if __name__=='__main__': init(); print('BrowserUnblocked control server listening on http://%s:%s'%(HOST,PORT),flush=True); print('BrowserUnblocked multi-session storage: '+STORE,flush=True); ThreadingHTTPServer((HOST,PORT),H).serve_forever()
