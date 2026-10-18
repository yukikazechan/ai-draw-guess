import {paint,W,H} from './drawing.mjs';

const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let user=null,config=null,room=null,socket=null,reconnectTimer,setupRequired=false,registrationOpen=true,authMode='login',roomKey='',drawKey='',localShapes=[],stroke=null,lastSent=0,sendTimer,submitting=false;
const canvas=$('roomCanvas');
const phaseNames={drawing:'画手正在作画', 'drawing-ai':'AI 正在作画',ready:'画作已准备好',guessing:'大家正在猜词',locked:'正在公布本次结果',review:'等待画手补画',reveal:'本题揭晓',finished:'比赛结束','draw-error':'AI 作画失败'};
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function adoptRoom(next){if(next&&room?.id===next.id&&(next.version||0)<(room.version||0))return;room=next;}
async function api(path,data){
  const response=await fetch(path,data===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json','X-Game-Request':'1'},body:JSON.stringify(data)});
  const value=await response.json();
  if(!response.ok){if(response.status===401&&user){user=null;location.assign('/online');}throw new Error(value.error||'操作失败，请重试。');}return value;
}
async function task(button,fn){if(button.disabled)return;button.disabled=true;try{await fn();}catch(e){message(e.message,true);}finally{button.disabled=false;}}
function aiOptions(target,ids,players=config.players){$(target).innerHTML=players.filter(p=>p.enabled).map(p=>`<label><input type="checkbox" name="playerIds" value="${esc(p.id)}" ${ids.includes(p.id)?'checked':''}>${esc(p.name)}</label>`).join('')||'<span class="muted">你还没有配置自己的 AI。可以先玩真人对局，或在“我的 AI”中保存自己的模型与 Key。</span>';}
function fillForm(form,defaults={}){for(const key of ['category','wordLevel','rounds','hintMode'])if(form.elements[key])form.elements[key].value=defaults[key]??({category:'动物',wordLevel:'easy',rounds:1,hintMode:'visual'}[key]);form.elements.useCustomWords.checked=!!defaults.useCustomWords;}
function formOptions(form){const data=new FormData(form);return {category:data.get('category'),wordLevel:data.get('wordLevel'),rounds:Number(data.get('rounds')),playerIds:data.getAll('playerIds'),useCustomWords:data.has('useCustomWords')};}
function setAuthMode(mode){authMode=mode==='register'&&registrationOpen?'register':'login';const register=authMode==='register';$('authTabs').hidden=setupRequired;$('switchRegister').hidden=!registrationOpen;$('switchLogin').setAttribute('aria-pressed',String(!register));$('switchRegister').setAttribute('aria-pressed',String(register));$('tokenField').hidden=!setupRequired;$('tokenField').querySelector('input').required=setupRequired;$('nameField').hidden=!setupRequired&&!register;$('nameField').querySelector('input').required=setupRequired||register;$('authTitle').textContent=setupRequired?'创建首位管理员':register?'注册你的画桌账号':'登录画桌';$('loginButton').textContent=setupRequired?'创建管理员并登录':register?'注册并登录':'登录';$('loginForm').elements.password.autocomplete=setupRequired||register?'new-password':'current-password';$('authError').textContent='';}
$('switchLogin').onclick=()=>setAuthMode('login');$('switchRegister').onclick=()=>setAuthMode('register');
async function boot(){
  disconnect();const status=await api('/api/auth/status');user=status.user;setupRequired=status.setupRequired;registrationOpen=status.registrationOpen;
  $('auth').hidden=!!user;$('hall').hidden=!user;$('logout').hidden=!user;$('soloLink').hidden=!user;$('admin').hidden=true;$('roomView').hidden=true;
  const guest=user?.role==='guest';$('identity').textContent=user?`${user.name}${user.role==='admin'?' · 管理员':guest?' · 游客':''}`:'';
  $('guestUpgrade').hidden=!guest||!registrationOpen;$('recordingsLink').hidden=!user;$('soloLink').hidden=!user||guest;$('soloHallLink').hidden=guest;$('createRoom').parentElement.hidden=guest;
  $('my-ai').hidden=!user||guest;
  $('personalAiLink').hidden=!user||guest;
  $('hallHelp').textContent=guest?'游客可以输入朋友的房间码加入。注册账号后，也能创建自己的画桌。':'创建一张画桌，把房间码发给朋友。也可以直接加入他们。';
  if(!user){setAuthMode(authMode);const invitation=new URL(location.href).searchParams.get('room');$('guestInvite').hidden=!invitation||!status.guestsAllowed||setupRequired;$('authHelp').textContent=registrationOpen?'注册账号保存对局，或通过朋友的邀请以游客身份加入。':'使用管理员给你的账号登录，也可通过邀请以游客身份加入。';message(setupRequired?'首次使用：请从服务器启动日志获取初始化码。':invitation?'收到邀请了！填写昵称直接入座，或登录已有账号。':'登录或注册账号，创建你的画桌。');return;}
  config=await api('/api/config');
  renderAiStatus();profileFingerprint=JSON.stringify(config.players);
  for(const form of [$('matchForm'),$('defaultsForm')])form.elements.category.innerHTML=config.categories.map(c=>`<option>${esc(c.name)}</option>`).join('');
  fillForm($('matchForm'),config.defaults);aiOptions('roomAi',config.defaults.playerIds??config.players.filter(p=>p.enabled).map(p=>p.id));
  $('customCount').textContent=`（${config.defaults.customWordCount||0} 词）`;
  if(user.role==='admin')await loadAdmin();
  room=(await api('/api/rooms/state')).room;
  const code=new URL(location.href).searchParams.get('room');
  if(!room&&code){try{room=(await api('/api/rooms/join',{code})).room;}catch(e){message(e.message,true);}}
  renderRoom();if(room)connect();else if(!code)message('已登录。创建房间或输入朋友的房间码。');
  if(location.hash==='#my-ai')$('my-ai').scrollIntoView({block:'start'});
}
$('loginForm').addEventListener('submit',async event=>{event.preventDefault();await task($('loginButton'),async()=>{const data=Object.fromEntries(new FormData(event.currentTarget));$('authError').textContent='';try{await api(setupRequired?'/api/auth/setup':authMode==='register'?'/api/auth/register':'/api/auth/login',data);event.target.reset();await boot();}catch(e){$('authError').textContent=e.message;}});});
$('guestForm').addEventListener('submit',async event=>{event.preventDefault();await task(event.submitter,async()=>{await api('/api/auth/guest',{name:new FormData(event.target).get('name'),code:new URL(location.href).searchParams.get('room')});await boot();message('已以游客身份加入。你可以随时注册，保留当前对局记录。');});});
$('upgradeForm').addEventListener('submit',async event=>{event.preventDefault();await task(event.submitter,async()=>{await api('/api/auth/register',Object.fromEntries(new FormData(event.target)));event.target.reset();await boot();message('注册成功！当前身份、得分和已有对局记录均已保留。');});});
$('logout').onclick=()=>task($('logout'),async()=>{await api('/api/auth/logout',{});disconnect();location.assign('/online');});
$('createRoom').onclick=()=>task($('createRoom'),async()=>{room=(await api('/api/rooms/create',{})).room;renderRoom();connect();message('房间已创建，把邀请链接发给朋友。');});
$('joinForm').addEventListener('submit',async event=>{event.preventDefault();await task(event.submitter,async()=>{room=(await api('/api/rooms/join',{code:new FormData(event.target).get('code')})).room;renderRoom();connect();message('已加入房间，等待房主开局。');});});
$('leaveRoom').onclick=()=>task($('leaveRoom'),async()=>{if(room?.game&&!['finished'].includes(room.game.phase)&&!window.confirm('离开会结束当前比赛，确定离开吗？'))return;await api('/api/rooms/leave',{});room=null;disconnect();history.replaceState(null,'','/online');renderRoom();message('已离开房间。');});
$('copyRoom').onclick=()=>task($('copyRoom'),async()=>{const url=new URL('/online',location.origin);url.searchParams.set('room',room.id);try{await navigator.clipboard.writeText(url.href);message('邀请链接已复制。朋友打开后可直接作为游客加入。');}catch{message(`房间码：${room.id}，邀请链接：${url.href}`);}});
$('matchForm').addEventListener('submit',async event=>{event.preventDefault();await task($('startRoom'),async()=>{adoptRoom((await api('/api/rooms/start',formOptions(event.target))).room);renderRoom();});});
function disconnect(){clearTimeout(reconnectTimer);clearTimeout(sendTimer);const old=socket;socket=null;old?.close();}
function connect(){
  disconnect();if(!room||!user)return;const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/ws/room`);socket=ws;
  ws.onopen=()=>{if(socket!==ws)return;$('connection').textContent='已实时连接 · 笔画自动同步';renderGame();};
  ws.onmessage=event=>{if(socket!==ws)return;try{const data=JSON.parse(event.data);if(data.type==='state'){adoptRoom(data.room);renderRoom();}else if(data.type==='error')message(data.error,true);}catch{message('房间同步失败，正在重新连接。',true);ws.close();}};
  ws.onclose=()=>{if(socket!==ws)return;$('connection').textContent='连接断开，正在重连…';renderGame();reconnectTimer=setTimeout(async()=>{try{room=(await api('/api/rooms/state')).room;renderRoom();if(room)connect();}catch(e){message(e.message,true);connect();}},1800);};
  ws.onerror=()=>{$('connection').textContent='实时连接不可用，请检查网络或反向代理的 WebSocket 设置。';};
}
function renderRoom(){
  $('hall').hidden=!!room||!user;$('roomView').hidden=!room;if(!room)return;
  const host=room.hostId===user.id,newRoom=roomKey!==room.id;roomKey=room.id;
  $('roomCode').textContent=room.id;
  $('members').innerHTML=room.members.map(p=>`<span class="member">${esc(p.name)}${p.id===user.id?'（你）':''}<small>${p.id===room.hostId?'房主 · ':''}${p.connected?'在线':'未连接'}</small></span>`).join('');
  const waiting=!room.game||room.game.phase==='finished';$('matchForm').hidden=!waiting;
  $('hostHelp').textContent=host?'选择题库和 AI，所有朋友入座后开始。真人也可以单独成局。':'房主正在准备比赛。你可以把房间码分享给其他朋友。';
  for(const element of $('matchForm').elements)element.disabled=!host;
  for(const part of $('matchForm').querySelectorAll('.field-row,fieldset,.inline-label'))part.hidden=!host;
  $('startRoom').hidden=!host;
  if(newRoom){fillForm($('matchForm'),config.defaults);aiOptions('roomAi',config.defaults.playerIds??config.players.filter(p=>p.enabled).map(p=>p.id));for(const element of $('matchForm').elements)element.disabled=!host;}
  $('startRoom').textContent=room.game?'再开一局':'开始比赛';
  renderGame();
}
function renderGame(){
  const g=room?.game;$('matchView').hidden=!g;if(!g)return;
  const host=room.hostId===user.id,artist=g.artistId===user.id,connected=socket?.readyState===WebSocket.OPEN;
  const key=`${g.id}:${g.index}:${g.turn}`;
  if(key!==drawKey){drawKey=key;stroke=null;localShapes=structuredClone(g.shapes);$('guessInput').value='';}
  const canDraw=artist&&g.phase==='drawing'&&connected;
  if(!canDraw){localShapes=structuredClone(g.shapes);stroke=null;}
  paint(canvas,localShapes);canvas.dataset.drawing=String(canDraw);$('drawTools').hidden=!canDraw;
  $('roundTitle').textContent=g.phase==='finished'?'比赛结束，看看谁最懂你的画':g.phase==='idle'?'正在准备第一题…':`第 ${g.index+1} / ${g.total} 题 · ${g.artistName} 作画${g.answer?` · 答案：${g.answer}`:` · ${g.length} 个字`}`;
  $('phaseLabel').textContent=phaseNames[g.phase]||g.phase;$('gameNotice').textContent=[g.notice,g.recordingWarning].filter(Boolean).join(' ');
  const own=g.results[user.id],canGuess=g.phase==='guessing'&&own&&!own.solved&&!['confident','submitted'].includes(own.status);
  $('guessForm').hidden=!canGuess;
  const buttons=[];
  const add=(action,label,primary=false)=>buttons.push(`<button data-action="${action}"${submitting?' disabled':''}${primary?' class="primary"':''}>${label}</button>`);
  if(g.phase==='drawing'&&artist)add('draw-done','画好了，开始猜',true);
  if(g.phase==='ready'&&host)add('draw-done','公布画作，开始猜',true);
  if(g.phase==='review'&&(g.artistHuman?artist:host))add('revise','补几笔，再猜一次',true);
  if(g.phase==='reveal'&&host)add('next','下一题',true);
  if(g.phase==='draw-error'&&host)add('retry-draw','重试 AI 作画');
  if(g.phase==='guessing'&&host&&Object.values(g.results).some(r=>r.status==='error')){add('retry-guesses','重试失败的 AI');add('skip-errors','跳过失败的 AI');}
  if(host&&!['reveal','finished'].includes(g.phase))add('reveal','揭晓并结束本题');
  if(host&&g.phase!=='finished')add('finish','结束比赛');
  $('roundActions').innerHTML=buttons.join('');
  $('scores').innerHTML=g.players.map(p=>{const r=g.results[p.id],state=p.id===g.artistId&&g.phase!=='finished'?'画手':r?.solved?'已猜中':r?.status==='waiting'?'等待猜词':['thinking','queued'].includes(r?.status)?'正在想':r?.status==='error'?'调用失败':['confident','submitted'].includes(r?.status)?'已提交':'';return `<li><span>${esc(p.name)}${p.human?'':' · AI'}${state?`<small> · ${state}</small>`:''}</span><strong>${p.total} 分</strong></li>`;}).join('');
  const log=$('roomMessages'),atBottom=log.scrollHeight-log.scrollTop-log.clientHeight<50;
  const markup=g.conversation.slice(-120).map(m=>`<p><strong>${esc(m.name)}：</strong>${esc(m.text)}${m.kind==='guess'?(m.correct?' ✓ 猜中了':' · 未猜中'):''}</p>`).join('')||'<p class="muted">比赛消息会出现在这里。</p>';
  if(log.innerHTML!==markup){log.innerHTML=markup;if(atBottom)log.scrollTop=log.scrollHeight;}
}
async function action(action,extra={}){
  if(submitting||!room?.game)return;const g=room.game;submitting=true;renderGame();
  try{
    const payload={gameId:g.id,index:g.index,turn:g.turn,action,...extra};
    if(action==='draw-done')payload.shapes=localShapes;
    await api('/api/rooms/action',payload);adoptRoom((await api('/api/rooms/state')).room);renderRoom();
  }catch(e){message(e.message,true);}finally{submitting=false;renderGame();}
}
$('roundActions').onclick=event=>{const button=event.target.closest('[data-action]');if(!button)return;const name=button.dataset.action;if(['finish','reveal'].includes(name)&&!window.confirm(name==='finish'?'确定结束本场比赛？':'提前揭晓会结束本题，确定继续吗？'))return;action(name);};
$('guessForm').addEventListener('submit',event=>{event.preventDefault();action('guess',{guess:$('guessInput').value});});
$('passGuess').onclick=()=>action('pass');
function point(event){const box=canvas.getBoundingClientRect();return [Math.round(Math.max(0,Math.min(W,(event.clientX-box.left)/box.width*W))),Math.round(Math.max(0,Math.min(H,(event.clientY-box.top)/box.height*H)))];}
function sendDrawing(){
  clearTimeout(sendTimer);if(!room?.game||socket?.readyState!==WebSocket.OPEN)return;
  if(Date.now()-lastSent<110){sendTimer=setTimeout(sendDrawing,110);return;}
  const g=room.game,data=JSON.stringify({type:'drawing',gameId:g.id,index:g.index,turn:g.turn,shapes:localShapes});
  if(data.length>240000){message('这幅画笔迹太多，请撤销部分笔画后再画。',true);return;}
  socket.send(data);lastSent=Date.now();
}
canvas.onpointerdown=event=>{if(canvas.dataset.drawing!=='true'||event.button!==0||stroke)return;if(localShapes.length>=450){message('最多 450 笔，请先撤销部分笔画。',true);return;}event.preventDefault();canvas.setPointerCapture(event.pointerId);const p=point(event);stroke={type:'line',color:$('ink').value,width:Number($('width').value),points:[p,p]};localShapes.push(stroke);paint(canvas,localShapes);sendDrawing();};
canvas.onpointermove=event=>{if(!stroke)return;const p=point(event),last=stroke.points.at(-1);if(p[0]===last[0]&&p[1]===last[1])return;if(stroke.points.length<1800)stroke.points.push(p);paint(canvas,localShapes);sendDrawing();};
const endStroke=()=>{if(stroke){stroke=null;sendDrawing();}};canvas.onpointerup=endStroke;canvas.onpointercancel=endStroke;canvas.onlostpointercapture=endStroke;
$('undo').onclick=()=>{stroke=null;localShapes.pop();paint(canvas,localShapes);sendDrawing();};$('clear').onclick=()=>{stroke=null;localShapes=[];paint(canvas,localShapes);sendDrawing();};
async function loadAdmin(){
  $('admin').hidden=false;const {defaults,players}=await api('/api/admin/defaults');fillForm($('defaultsForm'),defaults);$('defaultsForm').elements.customWords.value=(defaults.customWords||[]).join('\n');aiOptions('defaultAi',defaults.playerIds??players.filter(p=>p.enabled).map(p=>p.id),players);await loadUsers();
}
let profileFingerprint='';
function renderAiStatus(){const saved=config.players.filter(p=>p.hasKey).length;$('aiProfileStatus').textContent=`已保存 ${config.players.length} 位选手，其中 ${saved} 位已配置 Key。修改后下一场比赛使用新配置。`;}
$('publishTemplate').onclick=()=>task($('publishTemplate'),async()=>{await api('/api/admin/template',{});message('已发布新用户模板，模型和角色配置会继承，所有 Key 均已排除。');});
setInterval(async()=>{if(!user||user.role==='guest'||document.hidden)return;try{const next=await api('/api/config'),fingerprint=JSON.stringify(next.players);config=next;renderAiStatus();if(profileFingerprint!==fingerprint){profileFingerprint=fingerprint;if(!room?.game||room.game.phase==='finished'){aiOptions('roomAi',config.defaults.playerIds||[]);if(room)renderRoom();}}}catch{}},6000);
async function loadUsers(){const {users}=await api('/api/admin/users');$('users').innerHTML=users.map(p=>`<div class="user-row"><span>${esc(p.name)}<small>${esc(p.username)} · ${p.role==='admin'?'管理员':'玩家'} · ${p.active?'已启用':'已停用'}</small></span>${p.id===user.id?'<span class="muted">当前账号</span>':`<form data-user="${esc(p.id)}"><label class="sr-only" for="reset-${esc(p.id)}">为 ${esc(p.name)} 设置新密码</label><input id="reset-${esc(p.id)}" name="password" type="password" minlength="10" maxlength="128" autocomplete="new-password" placeholder="新密码，至少 10 位"><button type="submit">重置密码</button><button type="button" data-active="${p.active?'false':'true'}">${p.active?'停用':'启用'}</button></form>`}</div>`).join('');}
$('userForm').addEventListener('submit',async event=>{event.preventDefault();await task(event.submitter,async()=>{await api('/api/admin/users',Object.fromEntries(new FormData(event.target)));event.target.reset();await loadUsers();message('账号已创建，请把账号和初始密码告诉玩家。');});});
$('defaultsForm').addEventListener('submit',async event=>{event.preventDefault();await task(event.submitter,async()=>{const form=event.target;await api('/api/admin/defaults',{...formOptions(form),hintMode:form.elements.hintMode.value,customWords:form.elements.customWords.value.split(/\r?\n/).map(w=>w.trim()).filter(Boolean)});config=await api('/api/config');message('默认设置已保存，新房间将使用这些设置。');});});
$('users').addEventListener('submit',async event=>{event.preventDefault();const form=event.target;await task(event.submitter,async()=>{const password=form.elements.password.value;if(!password)throw new Error('请填写新密码。');await api('/api/admin/user',{id:form.dataset.user,password});await loadUsers();message('密码已更新，该玩家需要重新登录。');});});
$('users').onclick=event=>{const button=event.target.closest('[data-active]');if(!button)return;task(button,async()=>{await api('/api/admin/user',{id:button.closest('form').dataset.user,active:button.dataset.active==='true'});await loadUsers();message('账号状态已更新。');});};
setInterval(async()=>{if(!user||!room||document.hidden)return;try{const state=await api('/api/rooms/state');adoptRoom(state.room);renderRoom();if(!room)disconnect();}catch(e){message('连接失败：'+e.message,true);}},5000);
window.addEventListener('online',()=>{if(room)connect();});window.addEventListener('beforeunload',disconnect);
boot().catch(e=>message('加载失败：'+e.message+' 请刷新重试。',true));
