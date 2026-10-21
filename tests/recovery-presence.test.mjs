import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Game} from '../lib/game.mjs';
import {Rooms} from '../lib/rooms.mjs';
import {Banter} from '../lib/banter.mjs';
import {recoverModelRequest,isTransientModelError} from '../lib/model-recovery.mjs';
import {responseMessages,messageBody} from '../public/conversation.mjs';
import {seatPresentation} from '../public/seat-presentation.mjs';
import {renderRelayDrawing} from '../lib/relay-renderer.mjs';

const shapes=[{type:'rect',x:100,y:100,w:200,h:120,color:'#202633',width:5}],image=renderRelayDrawing(shapes);
const words=Array.from({length:10},()=>({answer:'西瓜',category:'物品'}));
const ai={id:'ai',name:'测试 AI'},human={id:'human',name:'玩家',human:true};
const game=run=>new Game({players:[ai],human:true,words,orderRandom:n=>n-1,revealDelay:0,recoveryDelay:0,run});

test('只重试暂时故障；鉴权、参数、额度和取消不重试',async()=>{
  for(const message of ['API 408','API 500','API 502','API 503','API 504','API 524','fetch failed','网络错误'])assert(isTransientModelError(new Error(message)));
  for(const message of ['API 400','API 401','API 403','API 404','API 429','今天的 AI 调用额度已用完','Expected JSON']){
    let calls=0;await assert.rejects(recoverModelRequest(async()=>{calls++;throw new Error(message);},{delayMs:0}));assert.equal(calls,1);
  }
  assert(!isTransientModelError(Object.assign(new Error('fetch failed'),{retryable:false})));
  assert(isTransientModelError(new DOMException('timeout','TimeoutError')));
});

test('猜词重试成功只判分一次，失败不拖住本轮，下一轮仍可正常猜',async()=>{
  let calls=0;const g=game(async()=>{calls++;if(calls<=2)throw new Error('API 503');return {guess:'西瓜'};});
  try{
    await g.next();await g.beginGuess({shapes,image});assert.equal(calls,2);assert.equal(g.phase,'review');
    assert.equal(g.results.ai.history.length,1);assert(g.results.ai.history[0].callFailed);assert.equal(g.results.ai.points,0);
    await g.revise();await g.beginGuess({shapes,image});assert.equal(g.phase,'reveal');assert.equal(g.results.ai.points,2);assert.equal(g.results.ai.history.length,2);
  }finally{g.finish();}
});

test('重试等待可取消；切题后不会再次发起旧请求',async()=>{
  const controller=new AbortController();let calls=0;
  const task=recoverModelRequest(async()=>{calls++;throw new Error('API 503');},{signal:controller.signal,onRetry:()=>controller.abort(),delayMs:10});
  await assert.rejects(task);assert.equal(calls,1);
  const g=game(async()=>{throw new Error('API 503');});g.recoveryDelay=10000;
  try{await g.next();const pending=g.beginGuess({shapes,image});await new Promise(r=>setImmediate(r));assert(g.snapshot().results.ai.retrying);g.finish();await pending;assert.equal(g.phase,'finished');assert.equal(g.results.ai.history.length,0);}finally{g.finish();}
});

test('AI 作画暂时失败重试一次，再失败自动结束本题；配置错误保留可操作提示',async()=>{
  for(const message of ['API 503','API 401']){
    let calls=0;const g=game(async()=>{calls++;throw new Error(message);});
    try{await g.next();g.reveal();await g.next();assert.equal(calls,message==='API 503'?2:1);assert.equal(g.phase,message==='API 503'?'reveal':'draw-error');assert(g.notice.includes(message));}finally{g.finish();}
  }
});

class Socket extends EventEmitter{
  readyState=1;alive=true;
  send(value){this.last=JSON.parse(value);}
  close(){if(this.readyState===3)return;this.readyState=3;this.emit('close');}
  ping(){}
  terminate(){this.close();}
}
const host={id:'host',name:'原房主'},guest={id:'guest',name:'接任者'},observer={id:'observer',name:'观众'};
function roomFixture(){
  const owners=[];const rooms=new Rooms({accounts:{get:id=>[host,guest,observer].find(p=>p.id===id),charge(){},own(){}},recordings:{attach(){}},makeOptions:user=>({players:[{...ai,model:user.id}],category:'动物',orderRandom:n=>n-1,revealDelay:0,run:async()=>{owners.push(user.id);return {shapes};}}),lobbyOptions:user=>({players:[{...ai,model:user.id}],playerIds:['ai']})});
  rooms.create(host);const room=rooms.require(host);rooms.join(guest,room.id);
  const attach=user=>{const socket=new Socket();rooms.attach(socket,user,()=>true);return socket;};
  const hostSocket=attach(host),guestSocket=attach(guest);
  const expire=()=>{room.hostAbsence.deadline=Date.now()-1;rooms.notify(room);};
  return {rooms,room,owners,attach,hostSocket,guestSocket,expire};
}

test('房主短暂断线保留席位；重连取消移交，多标签有一条在线就不移交',()=>{
  const {rooms,room,attach,hostSocket}=roomFixture();
  try{
    const other=attach(host);hostSocket.close();assert.equal(room.hostAbsence,null);
    other.close();const deadline=room.hostAbsence.deadline;rooms.notify(room);assert.equal(room.hostAbsence.deadline,deadline);assert.equal(room.hostId,host.id);
    attach(host);assert.equal(room.hostAbsence,null);assert.equal(room.hostTimer,null);assert.equal(rooms.snapshot(room,guest).hostReconnectDeadline,null);
  }finally{rooms.close();}
});

test('断线到期优先移交在线参赛者，不结束当前比赛、不换本局配置，下一局切换',async()=>{
  const {rooms,room,attach,hostSocket,expire}=roomFixture();
  try{
    await rooms.start(host,{});rooms.join(observer,room.id);attach(observer);const g=room.game,run=g.run,deadline=g.clock.deadline;
    hostSocket.close();expire();assert.equal(room.hostId,guest.id);assert.equal(g.phase,'drawing');assert.equal(g.run,run);assert.equal(g.clock.deadline,deadline);assert.equal(room.lobby.players[0].model,host.id);
    assert.equal(room.messages.filter(m=>m.name==='系统').length,1);rooms.notify(room);assert.equal(room.messages.length,1);
    const stamp={gameId:g.id,index:g.index,turn:g.turn};await assert.rejects(rooms.action(host,{...stamp,action:'reveal'}),/房主/);
    await rooms.action(guest,{...stamp,action:'finish'});await rooms.action(guest,{...stamp,action:'home'});assert.equal(room.lobby.players[0].model,guest.id);
    await rooms.start(guest,{});assert.notEqual(room.game, g);assert.notEqual(room.game.run,run);
  }finally{rooms.close();}
});

test('没有在线接任者则保留原房主；观战者接任可推进，但不参与当前猜词计分',async()=>{
  const {rooms,room,attach,hostSocket,guestSocket,expire}=roomFixture();
  try{
    await rooms.start(host,{});rooms.join(observer,room.id);attach(observer);const g=room.game;
    guestSocket.close();hostSocket.close();expire();assert.equal(room.hostId,observer.id);assert.equal(g.snapshot(observer.id).viewerRole,'spectator');
    const stamp={gameId:g.id,index:g.index,turn:g.turn};await assert.rejects(rooms.action(observer,{...stamp,action:'guess',guess:'西瓜'}),/观战/);
    await rooms.action(observer,{...stamp,action:'reveal'});assert.equal(g.phase,'reveal');await rooms.action(observer,{...stamp,action:'next'});assert.equal(g.index,1);
    for(const ws of rooms.sockets)ws.close();rooms.syncHost(room);assert.equal(room.hostId,observer.id);assert.equal(room.hostTimer,null);
  }finally{rooms.close();assert.equal(room.hostTimer,null);assert.equal(room.clockTimer,null);}
});

test('每次 AI 互怼在聊天占位，成功替换同一条，失败、重试、取消都有状态',async()=>{
  let resolve,reject;const b=new Banter({players:[human,ai],pairs:[],context:{},image:null,run:()=>new Promise((ok,no)=>{resolve=ok;reject=no;}),publish:()=>{},touch:()=>{}});
  const state=()=>({id:'g',index:0,players:[human,ai],conversation:[],banter:b.snapshot()});
  let task=b.challenge({banterId:b.id,targetId:ai.id,text:'说两句'},human.id);await new Promise(r=>setImmediate(r));
  const waiting=responseMessages(state());assert.equal(waiting.length,1);assert.equal(waiting[0].delivery,'pending');assert.match(waiting[0].text,/正在回应/);assert.match(messageBody(waiting[0]),/aria-busy="true"/);
  reject(new Error('private upstream detail'));await task;const failed=responseMessages(state());assert.equal(failed[0].id,waiting[0].id);assert.equal(failed[0].delivery,'error');assert(!JSON.stringify(failed).includes('private upstream'));
  task=b.retry({banterId:b.id});await new Promise(r=>setImmediate(r));assert.equal(responseMessages(state())[0].delivery,'pending');resolve({line:'我在听。'});await task;
  const e=b.exchanges[0],complete={...state(),conversation:[{id:'server-id',kind:'banter',source:'model',exchangeId:e.id,reply:true,playerId:ai.id,text:e.reply,at:Date.now()}]};
  const replied=responseMessages(complete);assert.equal(replied.length,1);assert.equal(replied[0].id,waiting[0].id);assert.equal(replied[0].delivery,undefined);
  task=b.challenge({banterId:b.id,targetId:ai.id,text:'第二句'},human.id);await new Promise(r=>setImmediate(r));b.stop();assert.equal(responseMessages(state()).at(-1).delivery,'cancelled');resolve({line:'迟到'});await task;
});

test('准备聊天也使用 AI 名称占位，成功后无重复，@ 真人不伪造 AI 状态',()=>{
  const request={id:'human-message',kind:'chat',name:'玩家',source:'human',requestId:'job',targetId:'ai',targetName:'测试 AI',delivery:'pending',text:'你好',at:1};
  let result=responseMessages({conversation:[request]});assert.equal(result.length,2);assert.match(result[1].text,/测试 AI 正在回应/);
  const response={id:'actual',kind:'chat',name:'测试 AI',source:'model',replyTo:'job',text:'你好呀',at:2};
  result=responseMessages({conversation:[{...request,delivery:'replied'},response]});assert.equal(result.length,2);assert.equal(result[1].id,'lobby-response:job');assert(!result.some(m=>m.delivery==='pending'));
  assert.equal(responseMessages({conversation:[{kind:'chat',text:'@玩家'}]}).length,1);
  assert(!messageBody({...result[1],delivery:'pending',text:'<script>alert(1)</script>'}).includes('<script>'));
  assert.match(seatPresentation({results:{ai:{status:'queued',retrying:true}},players:[ai]},ai).status,/自动重试/);
});
