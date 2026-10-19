const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let user=null,config=null,setupRequired=false,registrationOpen=true,authMode='login';
function message(text,error=false){$('message').textContent=text;$('message').classList.toggle('error',error);}
function gameUrl(){const url=new URL('/',location.origin);url.searchParams.set('mode','online');const code=new URL(location.href).searchParams.get('room');if(code)url.searchParams.set('room',code);return url.href;}
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
  const status=await api('/api/auth/status');user=status.user;setupRequired=status.setupRequired;registrationOpen=status.registrationOpen;
  const params=new URL(location.href).searchParams,account=params.get('account')==='1'||location.hash==='#my-ai',guest=user?.role==='guest';
  if(user&&!account){location.replace(gameUrl());return;}
  $('auth').hidden=!!user;$('logout').hidden=!user;$('soloLink').hidden=!user;
  $('soloLink').href=gameUrl();$('soloLink').textContent='返回画桌';
  $('identity').textContent=user?user.name+(user.role==='admin'?' · 管理员':guest?' · 游客':''):'';
  $('guestUpgrade').hidden=!guest||!registrationOpen;$('recordingsLink').hidden=!user;$('my-ai').hidden=!user||guest;$('personalAiLink').hidden=!user||guest;$('admin').hidden=true;
  if(!user){setAuthMode(authMode);const invitation=params.get('room');$('guestInvite').hidden=!invitation||!status.guestsAllowed||setupRequired;$('authHelp').textContent=registrationOpen?'注册账号保存对局，或通过朋友的邀请以游客身份加入。':'使用管理员给你的账号登录，也可通过邀请以游客身份加入。';message(setupRequired?'首次使用：请从服务器启动日志获取初始化码。':invitation?'收到邀请了！填写昵称直接入座，或登录已有账号。':'登录或注册账号，继续画画。');return;}
  if(guest){message('你正在使用游客身份，可以注册账号保留当前身份和对局记录。');return;}
  config=await api('/api/config');renderAiStatus();
  $('defaultsForm').elements.category.innerHTML=config.categories.map(c=>'<option>'+esc(c.name)+'</option>').join('');
  if(user.role==='admin')await loadAdmin();
  message('账号设置。返回画桌即可继续人机或在线联机比赛。');
  if(location.hash==='#my-ai')$('my-ai').scrollIntoView({block:'start'});
}
$('loginForm').addEventListener('submit',async event=>{event.preventDefault();await task($('loginButton'),async()=>{const data=Object.fromEntries(new FormData(event.currentTarget));$('authError').textContent='';try{await api(setupRequired?'/api/auth/setup':authMode==='register'?'/api/auth/register':'/api/auth/login',data);event.target.reset();await boot();}catch(e){$('authError').textContent=e.message;}});});
$('guestForm').addEventListener('submit',async event=>{event.preventDefault();await task(event.submitter,async()=>{await api('/api/auth/guest',{name:new FormData(event.target).get('name'),code:new URL(location.href).searchParams.get('room')});await boot();message('已以游客身份加入。你可以随时注册，保留当前对局记录。');});});
$('upgradeForm').addEventListener('submit',async event=>{event.preventDefault();await task(event.submitter,async()=>{await api('/api/auth/register',Object.fromEntries(new FormData(event.target)));event.target.reset();await boot();message('注册成功！当前身份、得分和已有对局记录均已保留。');});});
$('logout').onclick=()=>task($('logout'),async()=>{await api('/api/auth/logout',{});location.assign('/online');});
async function loadAdmin(){
  $('admin').hidden=false;const {defaults,players}=await api('/api/admin/defaults');fillForm($('defaultsForm'),defaults);$('defaultsForm').elements.customWords.value=(defaults.customWords||[]).join('\n');aiOptions('defaultAi',defaults.playerIds??players.filter(p=>p.enabled).map(p=>p.id),players);await loadUsers();
}
function renderAiStatus(){const saved=config.players.filter(p=>p.hasKey).length;$('aiProfileStatus').textContent=`已保存 ${config.players.length} 位选手，其中 ${saved} 位已配置 Key。修改后下一场比赛使用新配置。`;}
$('publishTemplate').onclick=()=>task($('publishTemplate'),async()=>{await api('/api/admin/template',{});message('已发布新用户模板，模型和角色配置会继承，所有 Key 均已排除。');});
async function loadUsers(){const {users}=await api('/api/admin/users');$('users').innerHTML=users.map(p=>`<div class="user-row"><span>${esc(p.name)}<small>${esc(p.username)} · ${p.role==='admin'?'管理员':'玩家'} · ${p.active?'已启用':'已停用'}</small></span>${p.id===user.id?'<span class="muted">当前账号</span>':`<form data-user="${esc(p.id)}"><label class="sr-only" for="reset-${esc(p.id)}">为 ${esc(p.name)} 设置新密码</label><input id="reset-${esc(p.id)}" name="password" type="password" minlength="10" maxlength="128" autocomplete="new-password" placeholder="新密码，至少 10 位"><button type="submit">重置密码</button><button type="button" data-active="${p.active?'false':'true'}">${p.active?'停用':'启用'}</button></form>`}</div>`).join('');}
$('userForm').addEventListener('submit',async event=>{event.preventDefault();await task(event.submitter,async()=>{await api('/api/admin/users',Object.fromEntries(new FormData(event.target)));event.target.reset();await loadUsers();message('账号已创建，请把账号和初始密码告诉玩家。');});});
$('defaultsForm').addEventListener('submit',async event=>{event.preventDefault();await task(event.submitter,async()=>{const form=event.target;await api('/api/admin/defaults',{...formOptions(form),hintMode:form.elements.hintMode.value,customWords:form.elements.customWords.value.split(/\r?\n/).map(w=>w.trim()).filter(Boolean)});config=await api('/api/config');message('默认设置已保存，新房间将使用这些设置。');});});
$('users').addEventListener('submit',async event=>{event.preventDefault();const form=event.target;await task(event.submitter,async()=>{const password=form.elements.password.value;if(!password)throw new Error('请填写新密码。');await api('/api/admin/user',{id:form.dataset.user,password});await loadUsers();message('密码已更新，该玩家需要重新登录。');});});
$('users').onclick=event=>{const button=event.target.closest('[data-active]');if(!button)return;task(button,async()=>{await api('/api/admin/user',{id:button.closest('form').dataset.user,active:button.dataset.active==='true'});await loadUsers();message('账号状态已更新。');});};

boot().catch(e=>message('加载失败：'+e.message+' 请刷新重试。',true));
