import {randomBytes} from 'node:crypto';
import {Game} from './game.mjs';
import {validateShapes} from './shapes.mjs';
import {renderRelayDrawing,drawingHasInk} from './relay-renderer.mjs';
import {getKey,publicPlayer} from './providers.mjs';
import {isGuessPublished} from '../public/round-results.mjs';
import {strokeDuration} from '../public/drawing-playback.mjs';
import {characterSpeech} from '../public/characters.mjs';
import {lobbyChatPrompt,lobbyChatError} from './lobby-chat.mjs';

export class RoomGame extends Game {
  forfeitDrawing(){
    // Everyone finishes this question on exactly three guess points, including
    // players who already scored in an earlier attempt. The artist earns zero.
    this.artist.drawScore-=this.roundGain||0;this.roundGain=0;
    for(const player of this.players){
      const result=this.results[player.id];if(!result)continue;
      const gain=Math.max(0,3-result.points);player.guessScore+=gain;result.points=3;result.solved=true;result.status='solved';result.forfeit=true;result.judgedAt=Date.now();
      if(gain)result.history.push({turn:this.turn,guess:'',reason:'画手空白超时',skipped:true,correct:false,points:gain,forfeit:true,confidence:null});
    }
    this.addMessage(`forfeit:${this.index}`,{kind:'forfeit',text:'画手空白超时：画手本题 0 分，其他选手每人 3 分。'});
    this.reveal();this.notice='画手空白超时，本题画手 0 分，其他选手各 3 分。';this.touch();
  }
  snapshot(viewerId){
    const s=super.snapshot(),ended=['reveal','finished'].includes(this.phase),artist=this.index>=0&&this.index<this.total?this.artist:null,isArtist=viewerId===artist?.id,solved=!!this.results?.[viewerId]?.solved,participant=this.players.some(p=>p.human&&p.id===viewerId),multiplayer=this.players.filter(p=>p.human).length>1,canSeeCorrect=ended||isArtist||solved||participant&&!multiplayer;
    s.answer=artist&&(ended||isArtist||solved)?this.word.answer:null;
    s.hintChoice=isArtist?this.hintChoice:null;s.privateHintChoices=isArtist?this.privateHintChoices||{}:{};
    s.myHint=this.privateHints?.[viewerId]||'';s.privateHints=ended||isArtist?this.privateHints||{}:{};
    for(const [id,r] of Object.entries(this.results||{}))s.results[id].history=r.history.filter(h=>(ended||isArtist||id===viewerId||isGuessPublished(this,h))&&(canSeeCorrect||!h.correct));
    s.conversation=this.conversation.filter(m=>{
      const published=m.index<this.index||ended;
      if(m.kind==='hint'&&m.recipientId)return published||isArtist||m.recipientId===viewerId;
      if(m.kind==='guess')return (published||isGuessPublished(this,m)||isArtist||m.playerId===viewerId)&&(published||canSeeCorrect||!m.correct);
      return true;
    }).map(({artistHuman,...m})=>m);
    s.mode='battle';s.viewerId=viewerId;s.viewerRole=participant?'player':'spectator';s.recordingEnabled=participant&&!!this.recording;
    s.clock=this.clock?{...this.clock,serverNow:Date.now()}:null;
    s.recordingWarning=this.recording?.persistenceError||'';return s;
  }
}

export class Rooms {
  constructor({makeOptions,recordings,accounts,lobbyOptions=()=>({players:[],playerIds:[]}),lobbyRun=()=>{throw new Error('准备阶段 AI 未配置。');}}){this.rooms=new Map();this.byUser=new Map();this.makeOptions=makeOptions;this.recordings=recordings;this.accounts=accounts;this.lobbyOptions=lobbyOptions;this.lobbyRun=lobbyRun;this.sockets=new Set();}
  publicLobby(players){return {playerIds:players.map(p=>p.id),players:players.map(p=>{const {id,name,model,color,provider,characterId}=publicPlayer(p);return {id,name,model,color,provider,characterId};})};}
  lobbyState(user,ids){
    const options=this.lobbyOptions(user);ids=ids??options.playerIds;
    if(!Array.isArray(ids)||ids.length>12||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!options.players.some(p=>p.id===id)))throw new Error('请选择房主配置的有效 AI 选手。');
    return this.publicLobby(ids.map(id=>options.players.find(p=>p.id===id)));
  }
  setLobby(user,data){const room=this.require(user);if(data.roomId&&data.roomId!==room.id)throw new Error('房间已变更，请刷新后重试。');if(user.id!==room.hostId)throw new Error('只有房主可以选择 AI。');if(room.starting||room.game&&room.game.phase!=='finished')throw new Error('本局正在比赛，下一局再修改选手。');const next=this.lobbyState(user,data.playerIds),target=room.aiChat?.targetId;if(target&&(room.aiChat.playerSignature||JSON.stringify(room.lobby?.players.find(p=>p.id===target)))!==JSON.stringify(next.players.find(p=>p.id===target)))this.cancelLobbyChat(room,'所选 AI 已变更，本次回应已取消');room.lobby=next;this.notify(room);return this.snapshot(room,user);}
  require(user){const room=this.rooms.get(this.byUser.get(user.id));if(!room||!room.members.has(user.id))throw new Error('请先创建或加入房间。');room.last=Date.now();return room;}
  snapshot(room,user){return {id:room.id,version:room.version||0,hostId:room.hostId,lobby:room.lobby||{playerIds:[],players:[]},aiChat:room.aiChat?{id:room.aiChat.id,status:room.aiChat.status,fromId:room.aiChat.fromId,fromName:room.aiChat.fromName,targetId:room.aiChat.targetId,targetName:room.aiChat.targetName,error:room.aiChat.error}:null,members:[...room.members.values()].map(p=>({id:p.id,name:p.name,role:room.game&&!room.game.players.some(player=>player.human&&player.id===p.id)?'spectator':'player',connected:[...this.sockets].some(s=>s.userId===p.id&&s.roomId===room.id)})),messages:room.messages||[],game:room.game?.snapshot(user.id)||null};}
  notify(room){this.syncClock(room);room.version=(room.version||0)+1;if(room.pending)return;room.pending=true;queueMicrotask(()=>{room.pending=false;for(const ws of this.sockets)if(ws.roomId===room.id&&ws.readyState===1){if(ws.bufferedAmount>2_000_000){ws.close(1013,'连接过慢，请重新连接');continue;}ws.send(JSON.stringify({type:'state',room:this.snapshot(room,{id:ws.userId})}));}});}
  syncClock(room){
    const g=room.game,waitingHuman=g?.players?.some(p=>p.human&&g.results?.[p.id]&&!g.results[p.id].solved&&!g.results[p.id].pending&&!g.results[p.id].history.some(h=>h.turn===g.turn));
    const stage=g?.phase==='drawing'&&g.artist?.human?'draw':g?.phase==='guessing'&&waitingHuman?'guess':g?.phase==='review'&&!g.artist?.human?'revise':g?.phase==='ready'&&!g.artist?.human?'ready':null;
    const key=stage?`${g.id}:${g.index}:${g.turn}:${stage}`:'';
    if(room.clockKey===key)return;
    clearTimeout(room.clockTimer);room.clockTimer=null;room.clockKey=key;if(g)g.clock=null;
    if(!stage)return;
    const duration=stage==='revise'?3:stage==='ready'?Math.max(1,Math.min(20,Math.ceil(g.shapes.reduce((n,s)=>n+strokeDuration(s,'slow'),0)/1000))):(stage==='draw'?g.timeLimits?.drawSeconds:g.timeLimits?.guessSeconds)|| (stage==='draw'?90:45);
    g.clock={stage,duration,deadline:Date.now()+duration*1000};
    this.scheduleClock(room,g.clock,duration*1000);
  }
  scheduleClock(room,clock,delay){
    const game=room.game;clearTimeout(room.clockTimer);
    const timer=setTimeout(()=>{
      if(this.rooms.get(room.id)!==room||room.game!==game||game?.clock!==clock||room.clockTimer!==timer)return;
      room.clockTimer=null;this.expire(room);
    },Math.max(1,Math.ceil(delay)));
    room.clockTimer=timer;timer.unref?.();
  }
  expire(room){
    const g=room.game,c=g?.clock;if(this.rooms.get(room.id)!==room||!c)return;
    // Timers may fire before the wall-clock deadline; keep the transition armed.
    const remaining=c.deadline-Date.now();if(remaining>0){this.scheduleClock(room,c,remaining);return;}
    if(c.stage==='revise'&&g.phase==='review'&&!g.artist.human){this.launch(g,()=>g.revise());return;}
    if(c.stage==='ready'&&g.phase==='ready'&&!g.artist.human){
      const shapes=structuredClone(g.shapes);this.launch(g,async()=>{g.busy=true;try{await g.beginGuess({shapes,image:renderRelayDrawing(shapes)});}finally{g.busy=false;}});return;
    }
    if(c.stage==='draw'){
      if(g.busy){this.scheduleClock(room,c,100);return;}
      if(g.phase==='drawing'&&drawingHasInk(g.shapes)){
        const shapes=structuredClone(g.shapes);this.launch(g,async()=>{g.busy=true;try{await g.beginGuess({shapes,image:renderRelayDrawing(shapes)});}finally{g.busy=false;}});
        g.notice='作画时间到，已自动提交现有画作。';g.touch();
      }else{g.forfeitDrawing();}
    }else if(c.stage==='guess'&&g.phase==='guessing'){
      // AI requests keep their independently configured provider timeout.
      for(const player of g.players){const result=g.results[player.id];if(player.human&&result&&!result.solved&&!result.pending&&!result.history.some(h=>h.turn===g.turn)){g.record(player.id,'','作答超时，记 0 分',0,true);result.pending.timedOut=true;}}
      g.notice='玩家作答时间到，未提交者本轮 0 分。AI 仍按各自接口超时等待。';g.settle();g.touch();
    }
  }
  create(user){
    if(this.byUser.has(user.id))throw new Error('请先离开当前房间。');
    if(this.rooms.size>=100)throw new Error('房间已满，请稍后再试。');
    let id;do{id=randomBytes(4).toString('hex').toUpperCase();}while(this.rooms.has(id));
    const room={id,hostId:user.id,lobby:this.lobbyState(user),members:new Map([[user.id,{id:user.id,name:user.name}]]),game:null,last:Date.now()};
    this.rooms.set(id,room);this.byUser.set(user.id,id);return this.snapshot(room,user);
  }
  join(user,id){
    const key=String(id||'').trim().toUpperCase();if(this.byUser.get(user.id)===key)return this.snapshot(this.require(user),user);
    if(this.byUser.has(user.id))throw new Error('请先离开当前房间。');
    const room=this.rooms.get(key);if(!room)throw new Error('房间不存在或已关闭。');
    if(room.removed?.has(user.id))throw new Error('你已被房主移出该房间。');
    if(room.members.size>=8)throw new Error('房间最多容纳 8 位真人。');
    room.members.set(user.id,{id:user.id,name:user.name});room.last=Date.now();this.byUser.set(user.id,key);this.notify(room);return this.snapshot(room,user);
  }
  kick(user,data){const room=this.require(user);if(data.roomId!==room.id)throw new Error('房间已变更，请刷新后重试。');if(room.hostId!==user.id)throw new Error('只有房主可以移除成员。');if(data.userId===user.id)throw new Error('请使用离开房间退出。');if(!room.members.has(data.userId))throw new Error('该成员已离开房间。');(room.removed??=new Set()).add(data.userId);this.leave({id:data.userId},{code:4003,reason:'你已被房主移出房间'});return this.snapshot(room,user);}
  leave(user,{code=1000,reason='已离开房间'}={}){
    const room=this.require(user);this.byUser.delete(user.id);room.members.delete(user.id);
    if(room.hostId===user.id||room.aiChat?.fromId===user.id)this.cancelLobbyChat(room);
    // End a running round before changing its roster, so disconnected players cannot leave it waiting forever.
    if(room.game&&room.game.phase!=='finished'&&room.game.players.some(p=>p.human&&p.id===user.id))room.game.finish();
    else if(room.game?.banter)this.launch(room.game,()=>room.game.banter.humanLeft(user.id));
    for(const ws of this.sockets)if(ws.userId===user.id)ws.close(code,reason);
    if(!room.members.size){this.rooms.delete(room.id);return;}
    if(room.hostId===user.id){room.hostId=room.members.keys().next().value;room.lobby=this.lobbyState(room.members.get(room.hostId));}this.notify(room);
  }
  evict(userId){if(this.byUser.has(userId))this.leave({id:userId});for(const ws of this.sockets)if(ws.userId===userId)ws.close(1008,'请重新登录');}
  chat(user,data){
    const room=this.require(user),member=room.members.get(user.id);
    if(data.roomId&&data.roomId!==room.id)throw new Error('房间已变更，请刷新后重试。');
    if(typeof data.text!=='string'||!data.text.trim()||data.text.trim().length>200)throw new Error('聊天消息需要 1–200 字。');
    const target=data.targetId?room.members.get(data.targetId):null;
    if(!target&&room.lobby?.playerIds.includes(data.targetId)&&(!room.game||room.game.phase==='finished')){this.lobbyAI(user,{...data,roomId:room.id});return true;}
    if(data.targetId&&(!target||target.id===user.id))throw new Error('请选择房间里的其他真人成员。');
    const now=Date.now();if(member.chatAt&&now-member.chatAt<1000)throw new Error('消息发送太快，请稍候。');
    member.chatAt=now;
    const spectator=room.game&&!room.game.players.some(p=>p.human&&p.id===user.id);
    const message={id:randomBytes(12).toString('hex'),kind:'chat',playerId:user.id,name:member.name,color:'#344465',text:data.text.trim(),spectator:!!spectator,...(target?{targetId:target.id,targetName:target.name}:{}),at:now};
    this.addRoomMessage(room,message);
  }
  addRoomMessage(room,message){room.messages=[...(room.messages||[]),{id:randomBytes(12).toString('hex'),kind:'chat',at:Date.now(),...message}].slice(-200);this.notify(room);}
  setChatDelivery(room,job,delivery,text=''){const message=room.messages?.find(m=>m.requestId===job?.id&&m.source==='human');if(message){message.delivery=delivery;message.deliveryText=text;}}
  cancelLobbyChat(room,reason='房间状态已变更，本次回应已取消'){if(room.aiChat?.status==='working')this.setChatDelivery(room,room.aiChat,'cancelled',reason);room.aiController?.abort();room.aiController=null;room.aiChat=null;}
  lobbyAI(user,data,retry=false){
    const room=this.require(user);if(data.roomId!==room.id)throw new Error('房间已变更，请刷新后重试。');
    if(room.starting||room.game&&room.game.phase!=='finished')throw new Error('比赛已经开始，请在本题揭晓后 @ AI。');
    let job=room.aiChat;
    if(retry){
      if(!job||job.id!==data.chatId||job.status!=='error')throw new Error('这句回应已结束或变更。');
      if(user.id!==room.hostId&&user.id!==job.fromId)throw new Error('只有发起者或房主可以重试。');
      if(!room.members.has(job.fromId))throw new Error('发起者已离开房间。');
    }else{
      if(job?.status==='working')throw new Error('AI 正在回应，可以先与其他成员聊天。');
      if(typeof data.text!=='string'||!data.text.trim()||Array.from(data.text.trim()).length>120)throw new Error('请输入 1–120 字的消息。');
      job={id:randomBytes(12).toString('hex'),hostId:room.hostId,fromId:user.id,fromName:room.members.get(user.id).name,targetId:data.targetId,text:data.text.trim()};
    }
    const host=this.accounts.get?.(room.hostId)||room.members.get(room.hostId);
    const player=this.lobbyOptions(host).players.find(p=>p.id===job.targetId&&room.lobby.playerIds.includes(p.id));
    if(!player)throw new Error('请选择房主当前已选的 AI。');
    if(!['compatible','codex'].includes(player.provider)&&!getKey(player))throw new Error('房主尚未为这位 AI 配置 Key。');
    const run=this.lobbyRun(host);job.targetName=player.name;job.playerSignature=JSON.stringify(this.publicLobby([player]).players[0]);job.status='working';job.error='';
    if(!retry){
      const member=room.members.get(user.id),now=Date.now();if(member.chatAt&&now-member.chatAt<1000)throw new Error('消息发送太快，请稍候。');member.chatAt=now;
    }
    room.aiChat=job;const controller=new AbortController();room.aiController=controller;
    if(!retry)this.addRoomMessage(room,{playerId:user.id,name:job.fromName,color:'#344465',text:job.text,targetId:player.id,targetName:player.name,source:'human',requestId:job.id,delivery:'pending',deliveryText:`${player.name} 正在回应…`});
    else{this.setChatDelivery(room,job,'pending',`${player.name} 正在回应…`);this.notify(room);}
    const current=()=>!controller.signal.aborted&&this.rooms.get(room.id)===room&&room.aiChat===job&&room.hostId===job.hostId&&(!room.game||room.game.phase==='finished');
    room.aiTask=(async()=>{
      try{
        const result=await run(player,lobbyChatPrompt(player,job.fromName,room.messages),null,controller.signal);
        if(!current())return;
        if(typeof result?.line!=='string'||!result.line.trim())throw new Error('模型没有返回有效回应。');
        job.status='complete';this.setChatDelivery(room,job,'replied');this.addRoomMessage(room,{playerId:player.id,name:player.name,color:player.color||'#344465',model:player.model,text:characterSpeech(player,result.line,120),targetId:job.fromId,targetName:job.fromName,source:'model',replyTo:job.id});
      }catch(error){if(current()){job.status='error';job.error=lobbyChatError(error);this.setChatDelivery(room,job,'error',job.error);this.notify(room);}}
    })();
  }
  async start(user,data){
    const room=this.require(user);if(room.hostId!==user.id)throw new Error('只有房主可以开始比赛。');
    if(room.starting||room.game&&room.game.phase!=='finished')throw new Error('比赛正在进行。');
    room.starting=true;
    try{
      const context={},options=this.makeOptions(user,data,context),humans=[...room.members.values()].map((p,i)=>({...p,human:true,color:['#d63656','#344fd2','#258458','#9963b5','#d27a24','#317e91','#b44d78','#657a32'][i]}));
      if(humans.some(h=>options.players.some(p=>p.id===h.id)))throw new Error('AI 选手标识与玩家重复，请管理员修改 AI 标识。');
      if(data.banter!==undefined&&typeof data.banter!=='boolean')throw new Error('赛后互动选项无效。');
      const game=new RoomGame({...options,mode:'battle',human:false,humans,banter:data.banter===true});
      const drawSeconds=data.drawSeconds??90,guessSeconds=data.guessSeconds??45;
      if(!Number.isInteger(drawSeconds)||drawSeconds<30||drawSeconds>300||!Number.isInteger(guessSeconds)||guessSeconds<10||guessSeconds>120)throw new Error('作画时间须为 30–300 秒，猜词时间须为 10–120 秒。');
      game.timeLimits={drawSeconds,guessSeconds};
      context.matchId=game.id;context.category=game.category;
      this.accounts.charge(user.id,'matches');this.cancelLobbyChat(room,'比赛已开始，准备阶段的回应已取消');room.lobby=this.publicLobby(options.players);room.game=game;
      for(const member of room.members.keys())this.accounts.own(game.id,member);
      this.recordings.attach(game,{secrets:game.players.map(getKey)});
      const touch=game.touch.bind(game);game.touch=()=>{touch();this.notify(room);};
      this.launch(game,()=>game.next());this.notify(room);return this.snapshot(room,user);
    }finally{room.starting=false;}
  }
  launch(game,fn){const failed=e=>{if(!game.aborted){game.notice=e.message;game.touch();}};try{Promise.resolve(fn()).catch(failed);}catch(e){failed(e);}}
  async action(user,data){
    const room=this.require(user),g=room.game;if(!g||g.id!==data.gameId)throw new Error('比赛已变更，请刷新房间。');
    if(data.index!==g.index||data.turn!==g.turn)throw new Error('题目已更新，请重试。');
    const artist=user.id===g.artist?.id,host=user.id===room.hostId;
    if(data.action==='home'){
      if(!host||g.phase!=='finished')throw new Error('只有房主可以在比赛结束后准备下一局。');
      room.game=null;this.notify(room);return;
    }
    const banterAction=['banter-challenge','banter-reply','banter-retry','banter-skip'].includes(data.action);
    if(!banterAction&&!g.players.some(p=>p.human&&p.id===user.id))throw new Error('本局正在观战，下一局自动参赛；可以在房间聊天。');
    if(banterAction){
      const b=g.phase==='reveal'?g.banter:null;if(!b)throw new Error('当前没有互怼环节。');b.check(data);
      b.humanAvailable=id=>room.members.has(id);
      if(data.action==='banter-challenge'&&!room.members.has(data.targetId)&&!g.players.some(p=>p.id===data.targetId&&!p.human))throw new Error('对方已离开房间，请重新选择聊天对象。');
      // Observers may speak after reveal without joining the scoring roster.
      for(const id of [user.id,data.targetId]){const member=room.members.get(id);if(member&&!b.players.some(p=>p.id===id))b.players.push({id,name:member.name,human:true,spectator:true,color:'#344465'});}
      if(data.action==='banter-challenge'){g.challengePlayer(data,user.id);return;}
      if(data.action==='banter-reply'){
        if(b.exchanges[b.index]?.toId!==user.id)throw new Error('请等待轮到自己回应。');
        this.launch(g,()=>b.reply(data));
      }else{
        if(!host&&!(b.exchanges[b.index]?.manual&&b.exchanges[b.index]?.fromId===user.id))throw new Error('只有房主或这句互怼的发起者可以重试、跳过。');
        if(data.action==='banter-retry')this.launch(g,()=>b.retry(data));else b.skip(data);
      }
      return;
    }
    if(data.action==='guess'||data.action==='pass'){g.humanGuess(data.guess,data.action==='pass',user.id);return;}
    if(data.action==='draw-done'){
      if(g.artist?.human?!artist:!host)throw new Error('只有当前画手可以提交画作，AI 画作由房主确认。');
      if(g.busy)throw new Error('画作正在提交。');
      const shapes=g.artist.human?validateShapes(data.shapes):g.shapes;
      if(JSON.stringify(shapes).length>240000)throw new Error('画作过大，请减少笔画后再提交。');
      g.busy=true;try{await g.beginGuess({...data,shapes,image:renderRelayDrawing(shapes)});}finally{g.busy=false;}return;
    }
    if(data.action==='revise'){if(g.artist?.human?!artist:!host)throw new Error('只有画手可以改画。');this.launch(g,()=>g.revise());return;}
    if(!host)throw new Error('只有房主可以操作比赛进度。');
    switch(data.action){
      case 'next':if(g.phase!=='reveal')throw new Error('本题尚未结束。');this.launch(g,()=>g.next());break;
      case 'finish':g.finish();break;
      case 'reveal':g.reveal();break;
      case 'retry-draw':if(g.phase!=='draw-error')throw new Error('当前不能重试画图。');this.launch(g,()=>g.drawAI());break;
      case 'retry-guesses':if(g.phase!=='guessing')throw new Error('当前不能重试猜词。');this.launch(g,()=>g.guessAIs(true));break;
      case 'skip-errors':g.skipErrors();break;
      default:throw new Error('房间操作无效。');
    }
  }
  drawing(user,data){
    const room=this.require(user),g=room.game;if(!g||g.id!==data.gameId||g.phase!=='drawing'||g.artist.id!==user.id)throw new Error('只有当前画手可以修改画布。');
    if(data.index!==g.index||data.turn!==g.turn)throw new Error('题目已更新。');
    g.shapes=Array.isArray(data.shapes)&&!data.shapes.length?[]:validateShapes(data.shapes);g.revision++;g.updated=Date.now();this.notify(room);
  }
  attach(ws,user,authenticate){
    const room=this.require(user);if([...this.sockets].filter(s=>s.userId===user.id).length>=3)throw new Error('打开的房间窗口过多，请关闭其他窗口。');
    ws.userId=user.id;ws.roomId=room.id;ws.alive=true;this.sockets.add(ws);
    ws.on('pong',()=>{ws.alive=true;});
    ws.on('message',raw=>{try{
      if(!authenticate())return ws.close(1008,'登录已过期');
      const now=Date.now();if(now-(ws.period||0)>1000){ws.period=now;ws.messages=0;}if(++ws.messages>20)throw new Error('落笔太快，请稍候。');
      const data=JSON.parse(raw.toString());if(data.type!=='drawing')throw new Error('消息类型无效。');this.drawing(user,data);
    }catch(e){if(ws.readyState===1)ws.send(JSON.stringify({type:'error',error:e.message}));}});
    ws.on('close',()=>{this.sockets.delete(ws);this.notify(room);});ws.on('error',()=>{});this.notify(room);
  }
  sweep(){
    for(const ws of this.sockets){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}
    for(const room of this.rooms.values())if(Date.now()-room.last>6*3600000){room.game?.finish();for(const id of [...room.members.keys()])this.evict(id);}
  }
  close(){for(const room of this.rooms.values()){this.cancelLobbyChat(room);room.game?.finish();}for(const ws of this.sockets)ws.close(1001,'服务重启');}
}
