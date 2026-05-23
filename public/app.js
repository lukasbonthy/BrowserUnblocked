const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
let ws=null,viewport={width:1152,height:648},launched=false,lastMove=0,currentUser=localStorage.getItem('bu_name')||'',pointerDown=false;
function setStatus(t){const el=$('#status');if(el)el.textContent=t}
function userName(){return ($('#username')?.value||currentUser||'Guest').trim().slice(0,32)||'Guest'}
function setLoggedInUI(ok,c={}){currentUser=localStorage.getItem('bu_name')||currentUser||'Guest';$('#loginPanel')?.classList.toggle('hidden',ok);$('#sessionPanel')?.classList.toggle('hidden',!ok);$('#logout')?.classList.toggle('hidden',!ok);if(ok){$('#welcomeName')&&( $('#welcomeName').textContent=`Welcome, ${currentUser}` );$('#topSub')&&( $('#topSub').textContent=`${currentUser}'s private cloud browser` );$('#sessionId')&&( $('#sessionId').textContent=c.sessionId||'Private' );$('#sessionMeta')&&( $('#sessionMeta').textContent=`${c.sessions||0}/${c.maxSessions||'∞'} active sessions` );}}
async function api(path,opts={}){const r=await fetch(path,{headers:{'Content-Type':'application/json',...(opts.headers||{})},...opts});const d=await r.json().catch(()=>({}));if(!r.ok||d.ok===false)throw new Error(d.error||`Request failed ${r.status}`);return d}
async function boot(){const c=await api('/api/config');viewport=c.viewport||viewport;if(c.requiresLogin&&!c.authenticated){setLoggedInUI(false,c);setStatus('Sign in');return}setLoggedInUI(true,c);setStatus('Ready')}
function showViewer(){document.body.classList.add('is-streaming');$('#welcome')?.classList.add('hidden');$('#features')?.classList.add('hidden');$('#viewer')?.classList.remove('hidden');$('#screenWrap')?.focus()}
function launch(){if(ws)try{ws.close()}catch{};showViewer();$('#overlay')?.classList.remove('hidden');if($('#overlay'))$('#overlay').textContent='Connecting…';const proto=location.protocol==='https:'?'wss':'ws';ws=new WebSocket(`${proto}://${location.host}/stream`);ws.onopen=()=>setStatus('Connected');ws.onclose=()=>{if($('#overlay')){$('#overlay').classList.remove('hidden');$('#overlay').textContent='Disconnected. Click Reconnect.'}setStatus('Disconnected')};ws.onerror=()=>setStatus('Stream error');ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='ready'){viewport={width:m.width,height:m.height};launched=true;setStatus('Streaming');if(m.sessionId&&$('#viewerSession'))$('#viewerSession').textContent=`Session ${m.sessionId}`}if(m.type==='frame'){const screen=$('#screen');if(screen)screen.src=`data:image/jpeg;base64,${m.data}`;$('#overlay')?.classList.add('hidden')}if(m.type==='state'){if($('#title'))$('#title').textContent=m.title||'Cloud Chromium';if(m.url&&$('#url'))$('#url').value=m.url;if(m.sessionId){$('#viewerSession')&&( $('#viewerSession').textContent=`Session ${m.sessionId}` );$('#sessionId')&&( $('#sessionId').textContent=m.sessionId )}}if(m.type==='error'){$('#overlay')&&( $('#overlay').textContent=m.error||'Error', $('#overlay').classList.remove('hidden') )}}}
function send(o){if(ws&&ws.readyState===1)ws.send(JSON.stringify(o))}
function coords(ev){
  const screen=$('#screen');
  const r=screen.getBoundingClientRect();
  const vw=viewport.width||1152, vh=viewport.height||648;
  const boxRatio=r.width/r.height, streamRatio=vw/vh;
  let left=r.left, top=r.top, width=r.width, height=r.height;
  if(boxRatio>streamRatio){width=r.height*streamRatio;left=r.left+(r.width-width)/2}else{height=r.width/streamRatio;top=r.top+(r.height-height)/2}
  const x=Math.max(0,Math.min(vw,Math.round((ev.clientX-left)/width*vw)));
  const y=Math.max(0,Math.min(vh,Math.round((ev.clientY-top)/height*vh)));
  return{x,y};
}
async function navigateTo(url){try{setStatus('Opening…');if($('#url'))$('#url').value=url;await api('/api/navigate',{method:'POST',body:JSON.stringify({url})});if(!launched)launch();else showViewer();setStatus('Ready')}catch(err){setStatus(err.message)}}
$('#launch')&&( $('#launch').onclick=()=>{if($('#loginPanel')&&!$('#loginPanel').classList.contains('hidden')){$('#username')?.focus();return}launch()} );
$('#launch2')&&( $('#launch2').onclick=launch );
$('#reconnect')&&( $('#reconnect').onclick=launch );
$('#demoScroll')&&( $('#demoScroll').onclick=()=>$('#features')?.scrollIntoView({behavior:'smooth',block:'center'}) );
$$('[data-quick]').forEach(b=>b.addEventListener('click',()=>{if($('#loginPanel')&&!$('#loginPanel').classList.contains('hidden')){$('#username')?.focus();setStatus('Sign in first');return}navigateTo(b.dataset.quick)}));
$('#loginForm')&&( $('#loginForm').onsubmit=async e=>{e.preventDefault();$('#loginError')&&( $('#loginError').textContent='' );try{currentUser=userName();localStorage.setItem('bu_name',currentUser);const out=await api('/api/login',{method:'POST',body:JSON.stringify({password:$('#password').value})});await boot();setStatus(`Ready, ${currentUser}`);if(out.sessionId&&$('#sessionId'))$('#sessionId').textContent=out.sessionId}catch(err){$('#loginError')&&( $('#loginError').textContent=err.message )}} );
$('#logout')&&( $('#logout').onclick=()=>{localStorage.removeItem('bu_name');location.reload()} );
$('#nav')&&( $('#nav').onsubmit=async e=>{e.preventDefault();await navigateTo($('#url').value)} );
$$('[data-action]').forEach(b=>b.onclick=async()=>{try{await api('/api/action',{method:'POST',body:JSON.stringify({action:b.dataset.action})});if(!launched)launch()}catch(err){setStatus(err.message)}});
const wrap=$('#screenWrap');if(wrap){
  wrap.style.touchAction='none';
  wrap.addEventListener('pointerdown',e=>{e.preventDefault();pointerDown=true;wrap.focus();try{wrap.setPointerCapture(e.pointerId)}catch{}const p=coords(e);send({kind:'mouse',event:'move',x:p.x,y:p.y});send({kind:'mouse',event:'down',x:p.x,y:p.y,button:e.button===2?'right':'left'})});
  wrap.addEventListener('pointerup',e=>{e.preventDefault();const p=coords(e);send({kind:'mouse',event:'move',x:p.x,y:p.y});send({kind:'mouse',event:'up',x:p.x,y:p.y,button:e.button===2?'right':'left'});if(pointerDown)send({kind:'mouse',event:'click',x:p.x,y:p.y,button:e.button===2?'right':'left'});pointerDown=false;try{wrap.releasePointerCapture(e.pointerId)}catch{}});
  wrap.addEventListener('pointercancel',()=>{pointerDown=false});
  wrap.addEventListener('contextmenu',e=>e.preventDefault());
  wrap.addEventListener('pointermove',e=>{const now=Date.now();if(now-lastMove<45)return;lastMove=now;const p=coords(e);send({kind:'mouse',event:'move',x:p.x,y:p.y})});
  wrap.addEventListener('wheel',e=>{e.preventDefault();send({kind:'mouse',event:'wheel',deltaX:e.deltaX,deltaY:e.deltaY})},{passive:false});
}
window.addEventListener('keydown',e=>{if(!launched||document.activeElement===$('#url')||document.activeElement===$('#password')||document.activeElement===$('#username'))return;e.preventDefault();if(e.ctrlKey||e.metaKey||e.altKey){let combo='';if(e.ctrlKey)combo+='Control+';if(e.altKey)combo+='Alt+';if(e.metaKey)combo+='Meta+';if(e.shiftKey)combo+='Shift+';combo+=e.key.length===1?e.key.toUpperCase():e.key;send({kind:'key',event:'press',key:combo});return}if(e.key.length===1)send({kind:'key',event:'text',text:e.key});else send({kind:'key',event:'press',key:e.key})});
if(currentUser&&$('#username'))$('#username').value=currentUser;boot().catch(e=>setStatus(e.message));
