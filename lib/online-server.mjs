import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {Accounts,publicUser} from './accounts.mjs';
import {Rooms} from './rooms.mjs';
import {CATEGORIES,CATEGORY_LEVELS} from './words.mjs';
import {normalizeHintMode} from '../public/visual-hints.mjs';
import {AiConfigStore,redactSecrets} from './ai-config-store.mjs';
import {publicApiFetch} from './public-api-fetch.mjs';
import {publicPlayer,getKey} from './providers.mjs';

export class OnlineServer {
  constructor({directory,port,getConfig,recordings,run,onRevoke=()=>{},onLegacyMigrated=()=>{}}){
    this.origin=new URL(process.env.PUBLIC_ORIGIN||`http://127.0.0.1:${port}`);
    if(!['http:','https:'].includes(this.origin.protocol)||this.origin.pathname!=='/'||this.origin.username||this.origin.password||this.origin.search||this.origin.hash)throw new Error('PUBLIC_ORIGIN 必须是站点根地址，例如 https://draw.example.com。');
    this.secure=this.origin.protocol==='https:';
    this.origins=new Set([this.origin.origin,`http://127.0.0.1:${port}`,`http://localhost:${port}`,`http://[::1]:${port}`]);
    this.hosts=new Set([...this.origins].map(x=>new URL(x).host));
    const limit=(key,fallback)=>{const n=Number(process.env[key]||fallback);if(!Number.isInteger(n)||n<1)throw new Error(key+' 必须为正整数。');return n;};
    this.accounts=new Accounts(join(directory,'accounts.sqlite'),{maxDailyMatches:limit('MAX_DAILY_MATCHES',20),maxDailyCalls:limit('MAX_DAILY_AI_CALLS',300),maxDailyTotalCalls:limit('MAX_DAILY_TOTAL_AI_CALLS',1000)});
    this.getConfig=getConfig;this.run=run;this.onRevoke=onRevoke;this.attempts=new Map();this.recordings=recordings;
    this.registrationOpen=process.env.ALLOW_REGISTRATION!=='false';this.guestsAllowed=process.env.ALLOW_GUESTS!=='false';
    this.setupToken=process.env.SETUP_TOKEN||randomBytes(24).toString('hex');
    if(!this.accounts.hasAdmin())console.log(`首次启动：打开 ${this.origin.origin}/online，使用初始化码创建管理员：${this.setupToken}`);
    this.profiles=new AiConfigStore(this.accounts,{directory,getLegacyConfig:getConfig,onLegacyMigrated});
    this.rooms=new Rooms({makeOptions:(user,data,context)=>this.makeOptions(user,data,context),recordings,accounts:this.accounts,lobbyRun:user=>this.userRun(user),lobbyOptions:user=>{const players=this.playersFor(user);return {players,playerIds:(this.defaults(user).playerIds??players.filter(p=>p.enabled).map(p=>p.id)).filter(id=>players.some(p=>p.id===id))};}});
  }
  throttle(req,label,limit=12){
    const key=(req.socket.remoteAddress||'')+':'+label,now=Date.now();let item=this.attempts.get(key);
    if(!item||now-item.since>900000){item={since:now,count:0};this.attempts.set(key,item);}
    if(++item.count>limit)throw new Error('尝试次数过多，请 15 分钟后再试。');
    if(this.attempts.size>10000)for(const [k,v] of this.attempts)if(now-v.since>900000)this.attempts.delete(k);
  }
  playersFor(user){return this.profiles.players(user);}
  publicPlayers(user){const config=this.profiles.get(user),players=this.playersFor(user);return redactSecrets(players.map(publicPlayer),[config.openrouterApiKey,...players.map(p=>p.apiKey)]);}
  userRun(user,run=this.run,context={}){return (p,prompt,image,signal,options={})=>{
    this.accounts.charge(user.id,'calls');
    return Promise.resolve().then(()=>run(p,prompt,image,signal,{...options,...(user.role!=='admin'?{fetchImpl:publicApiFetch}:{})})).then(result=>redactSecrets(result,[p.apiKey])).catch(error=>{const message=redactSecrets({message:error.message||'模型调用失败。'},[p.apiKey]).message;if(error instanceof Error){error.message=message;throw error;}throw new Error(message);});
  };}
  makeOptions(user,data,context={}){
    const config={players:this.playersFor(user)},defaults=this.defaults(user),ids=data.playerIds??defaults.playerIds??config.players.filter(p=>p.enabled).map(p=>p.id);
    if(!Array.isArray(ids)||ids.length>12||new Set(ids).size!==ids.length)throw new Error('AI 选手列表无效。');
    const players=ids.map(id=>config.players.find(p=>p.id===id));if(players.some(p=>!p))throw new Error('请选择房主自己配置的 AI。');
    if(players.some(p=>!['compatible','codex'].includes(p.provider)&&!getKey(p)))throw new Error('房主尚未为所选 AI 配置 Key，请先在“我的 AI”中保存。');
    const category=data.category??defaults.category??'动物',wordLevel=data.wordLevel??defaults.wordLevel??'easy',rounds=data.rounds??defaults.rounds??1;
    if(!CATEGORIES.some(c=>c.name===category)||!CATEGORY_LEVELS[category].some(l=>l.id===wordLevel)||![1,2,3,5].includes(rounds))throw new Error('题库或每人题数无效。');
    const useCustomWords=data.useCustomWords??defaults.useCustomWords??false;
    if(typeof useCustomWords!=='boolean')throw new Error('题库选项无效。');
    if(useCustomWords&&!defaults.customWordCount)throw new Error('管理员尚未配置自定义题库。');
    const privateWords=this.accounts.defaults().customWords;
    return {players:structuredClone(players),category,wordLevel,rounds,hintMode:normalizeHintMode(data.hintMode??defaults.hintMode??'visual'),run:this.userRun(user,this.run,context),...(useCustomWords?{words:privateWords.map(answer=>({answer,category,aliases:[]}))}:{})};
  }
  defaults(user){const {customWords=[],...defaults}=this.accounts.defaults();if(!user)return {...defaults,customWordCount:customWords.length};const players=this.playersFor(user),ids=user.role==='admin'&&Array.isArray(defaults.playerIds)?defaults.playerIds:players.filter(p=>p.enabled).map(p=>p.id);return {...defaults,customWordCount:customWords.length,playerIds:ids.filter(id=>players.some(p=>p.id===id&&p.enabled))};}
  async handle(req,res,path,{body,json}){
    const reply=(value,status)=>{json(res,value,status);return true;},a=this.accounts,user=req.user;
    if(req.method==='GET'&&path==='/api/auth/status')return reply({user:publicUser(user),setupRequired:!a.hasAdmin(),registrationOpen:this.registrationOpen,guestsAllowed:this.guestsAllowed});
    if(req.method==='POST'&&path==='/api/auth/register'){
      if(!this.registrationOpen||!a.hasAdmin())return reply({error:'当前暂未开放注册。'},403);
      this.throttle(req,'register',8);const data=await body(req);
      if(user&&user.role!=='guest')return reply({error:'当前已经登录账号。'},400);
      if(user?.role==='guest'){
        const upgraded=await a.registerGuest(user.id,data);res.setHeader('Set-Cookie',a.cookie(a.token(req),this.secure));return reply({user:upgraded},201);
      }
      const created=await a.create({...data,role:'user'}),login=a.issueSession(created);res.setHeader('Set-Cookie',a.cookie(login.token,this.secure));return reply({user:login.user},201);
    }
    if(req.method==='POST'&&path==='/api/auth/guest'){
      if(!this.guestsAllowed||!a.hasAdmin())return reply({error:'当前暂未开放游客加入。'},403);
      this.throttle(req,'guest',20);const data=await body(req),code=String(data.code||'').trim().toUpperCase(),room=this.rooms.rooms.get(code);
      if(!room)return reply({error:'邀请已失效，房间不存在或已关闭。'},404);
      if(user)return reply({user:publicUser(user),room:this.rooms.join(user,code)});
      if(room.members.size>=8)return reply({error:'房间已满，最多容纳 8 位真人。'},400);
      const guest=a.createGuest(data.name),joined=this.rooms.join(guest,code),login=a.issueSession(guest);
      res.setHeader('Set-Cookie',a.cookie(login.token,this.secure,true));return reply({user:login.user,room:joined},201);
    }
    if(req.method==='POST'&&['/api/auth/setup','/api/auth/login'].includes(path)){
      this.throttle(req,'auth-total',100);const data=await body(req);this.throttle(req,'auth:'+String(data.username||'').toLowerCase().slice(0,64));
      if(path==='/api/auth/setup'){
        if(a.hasAdmin()||this.settingUp)return reply({error:'管理员已初始化。'},403);
        if(typeof data.token!=='string'||data.token!==this.setupToken)return reply({error:'初始化码无效，请查看服务器启动日志。'},403);
        this.settingUp=true;try{await a.create({...data,role:'admin'});this.setupToken=null;}finally{this.settingUp=false;}
      }
      const login=await a.login(data.username,data.password);if(!login)return reply({error:'账号或密码错误，或账号已停用。'},401);
      res.setHeader('Set-Cookie',a.cookie(login.token,this.secure));return reply({user:login.user});
    }
    if(!user)return reply({error:'请先登录。'},401);
    if(user.role==='guest'&&['/api/config','/api/openrouter-key','/api/test'].includes(path)&&req.method==='POST')return reply({error:'注册账号后可以保存自己的 AI 配置。'},403);
    if(user.role==='guest'&&['/api/rooms/create','/api/start'].includes(path))return reply({error:'游客可以通过邀请加入房间。注册账号后可以创建房间或玩人机对局。'},403);
    if(req.method==='POST'&&path==='/api/auth/logout'){a.logout(req);this.rooms.evict(user.id);res.setHeader('Set-Cookie',a.cookie('',this.secure));return reply({ok:true});}
    const adminPath=path.startsWith('/api/admin/');
    if(adminPath&&user.role!=='admin')return reply({error:'此操作需要管理员权限。'},403);
    if(path==='/api/shutdown')return reply({error:'请通过服务器进程管理器停止服务。'},403);
    if(req.method==='GET'&&path==='/api/admin/users')return reply({users:a.list()});
    if(req.method==='GET'&&path==='/api/admin/defaults')return reply({defaults:a.defaults(),players:this.publicPlayers(user)});
    if(req.method==='POST'&&path.startsWith('/api/admin/')){
      const data=await body(req);
      if(path==='/api/admin/users'){this.throttle(req,'create-user',60);return reply({user:publicUser(await a.create({...data,role:'user'}))},201);}
      if(path==='/api/admin/user'){
        if(typeof data.id!=='string')throw new Error('账号编号无效。');
        const updated=await a.update(data.id,data,user.id);this.rooms.evict(data.id);this.onRevoke(data.id);return reply({user:updated});
      }
      if(path==='/api/admin/template'){this.profiles.publish(user);return reply({ok:true});}
      if(path==='/api/admin/defaults'){
        const {category,wordLevel,rounds}=data;
        if(!CATEGORIES.some(c=>c.name===category)||!CATEGORY_LEVELS[category].some(l=>l.id===wordLevel)||![1,2,3,5].includes(rounds))throw new Error('默认题库或题数无效。');
        if(!Array.isArray(data.playerIds)||data.playerIds.length>12||data.playerIds.some(id=>!this.playersFor(user).some(p=>p.id===id&&p.enabled)))throw new Error('默认 AI 选手无效。');
        if(!Array.isArray(data.customWords)||data.customWords.length>2000||data.customWords.some(w=>typeof w!=='string'||!w.trim()||w.length>40))throw new Error('自定义题库最多 2000 词，每词 1–40 字。');
        a.saveDefaults({category,wordLevel,rounds,hintMode:normalizeHintMode(data.hintMode),playerIds:[...new Set(data.playerIds)],useCustomWords:data.useCustomWords===true,customWords:[...new Set(data.customWords.map(w=>w.trim()))]});return reply({ok:true});
      }
      return reply({error:'未找到。'},404);
    }
    if(path.startsWith('/api/rooms/')){
      const rooms=this.rooms;
      if(req.method==='GET'&&path==='/api/rooms/state')return reply({room:rooms.byUser.has(user.id)?rooms.snapshot(rooms.require(user),user):null});
      if(req.method!=='POST')return reply({error:'未找到。'},404);
      this.throttle(req,'room-actions',1500);const data=await body(req);
      if(path==='/api/rooms/create')return reply({room:rooms.create(user)},201);
      if(path==='/api/rooms/join')return reply({room:rooms.join(user,data.code)});
      if(path==='/api/rooms/lobby')return reply({room:rooms.setLobby(user,data)});
      if(path==='/api/rooms/leave'){rooms.leave(user);return reply({ok:true});}
      if(path==='/api/rooms/kick')return reply({room:rooms.kick(user,data)});
      if(path==='/api/rooms/chat'){const ai=rooms.chat(user,data);return reply({ok:true},ai?202:200);}
      if(path==='/api/rooms/chat-ai'){rooms.lobbyAI(user,data);return reply({ok:true},202);}
      if(path==='/api/rooms/chat-ai/retry'){rooms.lobbyAI(user,data,true);return reply({ok:true},202);}
      if(path==='/api/rooms/start')return reply({room:await rooms.start(user,data)},202);
      if(path==='/api/rooms/action'){await rooms.action(user,data);return reply({ok:true});}
      return reply({error:'未找到。'},404);
    }
    return false;
  }
  attach(server){
    this.wss=new WebSocketServer({noServer:true,maxPayload:256000,perMessageDeflate:false});
    server.on('upgrade',(req,socket,head)=>{
      const reject=()=>{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');};
      if(!this.hosts.has(req.headers.host)||!this.origins.has(req.headers.origin)||req.url!=='/ws/room')return reject();
      const user=this.accounts.authenticate(req);if(!user||!this.rooms.byUser.has(user.id))return reject();
      this.wss.handleUpgrade(req,socket,head,ws=>{try{this.rooms.attach(ws,user,()=>!!this.accounts.authenticate(req));}catch(e){ws.close(1008,e.message);}});
    });
    this.timer=setInterval(()=>{this.rooms.sweep();for(const guest of this.accounts.expiredGuests())this.rooms.evict(guest.id);this.accounts.purgeGuests();this.recordings.pruneFinished(Date.now()-60000).catch(()=>{});},30000);this.timer.unref();
  }
  close(){clearInterval(this.timer);this.rooms.close();this.wss?.close();}
}
