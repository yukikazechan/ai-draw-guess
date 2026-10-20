import test from 'node:test';
import assert from 'node:assert/strict';
import {Rooms} from '../lib/rooms.mjs';
import {callModel} from '../lib/providers.mjs';
import {roomComposerState,roomMessageAction} from '../public/room-composer.mjs';
import {lobbyChatError} from '../lib/lobby-chat.mjs';

const host={id:'host',name:'房主',role:'admin'},guest={id:'guest',name:'加入者'},other={id:'other',name:'另一人'};
const model={id:'ai',name:'Gemini',characterId:'gemini',provider:'compatible',model:'host-model',baseUrl:'https://example.com/v1',apiKey:'PRIVATE-HOST-KEY'};
function setup(run){
  const calls=[],rooms=new Rooms({accounts:{get:id=>id===host.id?host:guest,charge(){},own(){}},recordings:{attach(){}},lobbyOptions:()=>({players:[model,{...model,id:'alt'}],playerIds:['ai']}),makeOptions:()=>({players:[],category:'动物',orderRandom:n=>n-1}),lobbyRun:owner=>async(p,prompt,image,signal)=>{calls.push({owner,p,prompt,image,signal});return run?run(p,prompt,image,signal):{line:'开局前也可以一起聊。'};}});
  rooms.create(host);const room=rooms.require(host);rooms.join(guest,room.id);rooms.join(other,room.id);
  return {rooms,room,calls};
}

test('准备阶段列出房主已选 AI，忙时可聊真人，比赛中仍不能通过闲聊绕过阶段',()=>{
  const room={id:'room',hostId:host.id,members:[host,guest],lobby:{players:[model]},game:null};
  let state=roomComposerState(room,guest.id);assert(state.preparing);assert(state.aiReady);assert.equal(state.targets.find(p=>p.id==='ai').disabled,false);
  assert.deepEqual(roomMessageAction(room,guest.id,'ai','你好'),{action:'lobby-ai',extra:{targetId:'ai',text:'你好'}});
  room.aiChat={id:'job',status:'working',fromId:guest.id,targetName:'Gemini'};assert(!roomComposerState(room,guest.id).aiReady);assert.equal(roomMessageAction(room,guest.id,host.id,'和真人聊天').action,'chat');
  room.game={phase:'guessing',players:[model]};assert(!roomComposerState(room,guest.id).preparing);assert.throws(()=>roomMessageAction(room,guest.id,'ai','偷偷问答案'),/当前不能/);
});

test('房间成员开局前使用房主模型聊天，保留公开上下文并且不生成对局或公开 Key',async()=>{
  const {rooms,room,calls}=setup();
  try{
    assert.throws(()=>rooms.lobbyAI(guest,{roomId:room.id,targetId:'alt',text:'未被选中'}),/已选/);
    assert.throws(()=>rooms.lobbyAI({id:'outsider'},{roomId:room.id,targetId:'ai',text:'不在房间'}),/加入房间/);
    rooms.lobbyAI(guest,{roomId:room.id,targetId:'ai',text:'第一句：开局前打个招呼。',fromId:host.id});await room.aiTask;
    assert.equal(calls[0].owner.id,host.id);assert.equal(calls[0].p.apiKey,model.apiKey);assert.equal(calls[0].image,null);
    assert.equal(room.messages[0].playerId,guest.id);assert.equal(room.messages[1].source,'model');assert.equal(room.messages[1].model,'host-model');
    room.members.get(guest.id).chatAt=0;
    rooms.lobbyAI(guest,{roomId:room.id,targetId:'ai',text:'第二句：接着刚才聊。'});await room.aiTask;
    assert(calls[1].prompt.includes('第一句：开局前打个招呼。'));assert(calls[1].prompt.includes(room.messages[1].text));assert(calls[1].prompt.includes('现在没有正在进行的题目'));
    assert(!calls[1].prompt.includes(model.apiKey));assert(!JSON.stringify(rooms.snapshot(room,guest)).includes(model.apiKey));assert.equal(room.game,null);assert.equal(room.members.size,3);
  }finally{rooms.close();}
});

test('准备聊天失败可由发起者或房主重试，保留原消息且不重复发布用户输入',async()=>{
  let fail=true;const {rooms,room,calls}=setup(()=>{if(fail)throw Error('upstream echoed '+model.apiKey);return {line:'这次回应成功。'};});
  try{
    rooms.lobbyAI(guest,{roomId:room.id,targetId:'ai',text:'请回应。'});await room.aiTask;assert.equal(room.aiChat.status,'error');assert.equal(room.messages.length,1);
    assert(!JSON.stringify(rooms.snapshot(room,guest)).includes(model.apiKey));
    const data={roomId:room.id,chatId:room.aiChat.id};assert.throws(()=>rooms.lobbyAI(other,data,true),/发起者或房主/);
    fail=false;rooms.lobbyAI(host,data,true);await room.aiTask;assert.equal(room.aiChat.status,'complete');assert.equal(room.messages.length,2);assert.equal(calls.length,2);
  }finally{rooms.close();}
});

test('首条请求不会被首次模型元信息同步或添加其他 AI 的后台同步取消',async()=>{
  let resolve;const {rooms,room,calls}=setup(()=>new Promise(done=>resolve=done));
  try{
    room.lobby.players[0].model='earlier-config-model';
    assert.equal(rooms.chat(host,{roomId:room.id,targetId:'ai',text:'房主的第一句。'}),true);const task=room.aiTask;
    rooms.setLobby(host,{playerIds:['ai','alt']});assert(!calls[0].signal.aborted);assert.equal(room.messages[0].delivery,'pending');
    resolve({line:'第一句就能回应。'});await task;
    assert.equal(room.messages[0].delivery,'replied');assert.equal(room.messages[1].replyTo,room.messages[0].requestId);assert.equal(room.messages[1].targetId,host.id);
  }finally{rooms.close();}
});

test('准备聊天的失败和取消状态保留在原消息上，不会静默消失',async()=>{
  let resolve;const {rooms,room}=setup(()=>new Promise(done=>resolve=done));
  try{
    rooms.lobbyAI(guest,{roomId:room.id,targetId:'ai',text:'等待回应。'});const task=room.aiTask;rooms.setLobby(host,{playerIds:['alt']});
    assert.equal(room.messages[0].delivery,'cancelled');assert.match(room.messages[0].deliveryText,/取消/);resolve({line:'迟到结果'});await task;assert.equal(room.messages.length,1);
  }finally{rooms.close();}
});

for(const action of ['start','selection','host-leave','sender-leave'])test(`准备聊天在 ${action} 后取消，迟到回复不能污染房间或比赛`,async()=>{
  let resolve;const {rooms,room,calls}=setup(()=>new Promise(done=>resolve=done));
  try{
    rooms.lobbyAI(guest,{roomId:room.id,targetId:'ai',text:'等待你的回应。'});const pending=room.aiTask;
    assert.throws(()=>rooms.lobbyAI(host,{roomId:room.id,targetId:'ai',text:'重复请求'}),/正在回应/);
    if(action==='start')await rooms.start(host,{playerIds:[]});
    if(action==='selection')rooms.setLobby(host,{playerIds:['alt']});
    if(action==='host-leave')rooms.leave(host);
    if(action==='sender-leave')rooms.leave(guest);
    assert(calls[0].signal.aborted);resolve({line:'这句不应出现。'});await pending;
    assert.equal(room.aiChat,null);assert(!JSON.stringify(rooms.snapshot(room,host)).includes('这句不应出现'));
    if(action==='start')assert.throws(()=>rooms.lobbyAI(guest,{roomId:room.id,targetId:'ai',text:'比赛期间绕过'}),/比赛已经开始/);
  }finally{rooms.close();}
});

test('504/524 返回清楚的上游超时提示，不回显任意错误正文，不自动重复扣费调用',async()=>{
  for(const status of [504,524]){
    let calls=0;await assert.rejects(callModel(model,'fixture',null,null,null,{modelProfile:null,fetchImpl:async()=>{calls++;return new Response('PRIVATE-HOST-KEY',{status});}}),error=>error.message.includes('上游等待模型响应超时')&&!error.message.includes(model.apiKey));
    assert.equal(calls,1);
  }
});

test('聊天失败区分超时、JSON 格式和参数错误，并且不反射任意上游内容',()=>{
  assert.match(lobbyChatError(new Error('接口已处理 60 秒仍未完成（不含排队）。')),/60 秒.*超时/);
  assert.match(lobbyChatError(new SyntaxError('Expected property')),/格式不正确/);
  assert.match(lobbyChatError(new Error('API 400：参数不受支持。')),/检查型号和思考档位/);
  assert(!lobbyChatError(new Error('unknown '+model.apiKey)).includes(model.apiKey));
});
