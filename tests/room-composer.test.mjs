import test from 'node:test';
import assert from 'node:assert/strict';
import {roomComposerState,roomMessageAction} from '../public/room-composer.mjs';
import {Rooms} from '../lib/rooms.mjs';
import {battleBanterContext,banterPrompt} from '../lib/banter.mjs';

const host={id:'host',name:'房主'},viewer={id:'viewer',name:'观众'};
const fixture=()=>({hostId:'host',members:[host,viewer],game:{phase:'reveal',banterEnabled:true,players:[{...host,human:true},{id:'ai',name:'Gemini'}],banter:{id:'b',status:'empty',index:0,exchanges:[]}}});

test('统一发送框支持观众公开聊天、@ 真人与 @ AI，AI 忙时仍能聊真人',()=>{
  const room=fixture();assert.equal(roomComposerState(room,viewer.id).aiReady,true);
  assert.equal(roomMessageAction(room,viewer.id,'','大家好').action,'chat');
  assert.deepEqual(roomMessageAction(room,viewer.id,host.id,'@房主'),{action:'chat',extra:{targetId:host.id,text:'@房主'}});
  assert.equal(roomMessageAction(room,viewer.id,'ai','接着刚才说').action,'banter-challenge');
  room.game.banter.status='working';room.game.banter.exchanges=[{fromId:viewer.id,fromName:viewer.name,toId:'ai',toName:'Gemini',status:'replying'}];
  assert.equal(roomMessageAction(room,viewer.id,host.id,'继续聊天').action,'chat');
  assert.throws(()=>roomMessageAction(room,viewer.id,'ai','继续怼'),/当前不能/);
  room.game.phase='guessing';assert(!roomComposerState(room,viewer.id).aiReady);
  room.game=null;assert.equal(roomMessageAction(room,viewer.id,host.id,'下一局').action,'chat');
});

test('被点名时仍使用同一发送框回应，三次限制只阻止继续发起 AI 互动',()=>{
  const room=fixture();room.game.banter.status='waiting-human';room.game.banter.exchanges=[{id:'e',fromId:'ai',fromName:'Gemini',toId:viewer.id}];
  assert.equal(roomComposerState(room,viewer.id).reply.id,'e');
  assert.deepEqual(roomMessageAction(room,viewer.id,'ai','让我解释'),{action:'banter-reply',extra:{banterId:'b',exchangeId:'e',text:'让我解释'}});
  room.game.banter.status='complete';room.game.banter.exchanges=Array.from({length:3},()=>({fromId:viewer.id,manual:true}));
  assert(!roomComposerState(room,viewer.id).aiReady);assert.equal(roomMessageAction(room,viewer.id,host.id,'聊真人').action,'chat');
});

test('观众揭晓后可以 @ AI，不加入计分名单，身份、重试、次数和题目阶段均受服务端约束',async()=>{
  const calls=[],rooms=new Rooms({accounts:{charge(){},own(){}},recordings:{attach(){}},makeOptions:()=>({players:[{id:'ai',name:'Gemini'}],category:'动物',orderRandom:n=>n-1,run:async(p,prompt)=>{calls.push(prompt);return {line:'我记得刚才的线索。'};}})});
  rooms.create(host);const room=rooms.require(host);rooms.join({id:'player',name:'玩家'},room.id);
  try{
    await rooms.start(host,{banter:true});rooms.join(viewer,room.id);const g=room.game,stamp={gameId:g.id,index:g.index,turn:g.turn};
    await assert.rejects(rooms.action(viewer,{...stamp,action:'banter-challenge',banterId:'b',targetId:'ai',text:'未揭晓'}),/互怼环节/);
    g.reveal();await g.banter.task;const scores=g.players.map(p=>p.drawScore+p.guessScore),size=g.players.length;
    for(let i=0;i<3;i++){await rooms.action(viewer,{...stamp,action:'banter-challenge',banterId:g.banter.id,targetId:'ai',text:'观众第'+i+'句'});await g.banter.task;}
    assert.equal(calls.length,3);assert(calls[2].includes('观众第0句'));assert.equal(g.players.length,size);assert(!g.players.some(p=>p.id===viewer.id));assert.deepEqual(g.players.map(p=>p.drawScore+p.guessScore),scores);
    assert.equal(g.conversation.find(m=>m.playerId===viewer.id).name,'观众');assert(g.conversation.find(m=>m.playerId===viewer.id).spectator);
    await assert.rejects(rooms.action(viewer,{...stamp,action:'banter-challenge',banterId:g.banter.id,targetId:'ai',text:'第四句'}),/3 次/);
    const before=calls.length;rooms.chat(viewer,{targetId:host.id,text:'真人不调用 AI'});assert.equal(calls.length,before);assert.equal(room.messages.at(-1).targetName,'房主');
    assert.throws(()=>rooms.chat(viewer,{targetId:'outsider',text:'不在房间'}),/其他真人/);
  }finally{rooms.close();}
});

test('首轮答对可以互动，但上下文明确首轮成功和真人无需填写理由',()=>{
  const game={artist:{id:'ai',name:'Gemini'},word:{answer:'牛头马面'},hint:'',hintMode:'visual',index:0,conversation:[],players:[{id:'ai',name:'Gemini'},{...host,human:true}],results:{host:{solved:true,history:[{turn:1,guess:'牛头马面',reason:'',correct:true,points:3}]}}};
  const context=battleBanterContext(game),record=context.players.find(p=>p.name==='房主');
  assert(record.firstTryCorrect);assert.equal(record.reasonRequired,false);assert.equal(record.guesses[0].reasonProvided,false);assert.equal(record.guesses[0].turn,1);assert.equal(record.guesses[0].points,3);
  const prompt=banterPrompt(context,{fromName:'Gemini',toName:'房主',kind:'human-answer'});
  assert(prompt.includes('不能编造他猜错、求救或依赖后续提示'));assert(prompt.includes('reason 为空表示没有收集理由'));
});

test('准备阶段向所有成员同步房主选择的 AI，公开数据只含角色与型号，房主交接后换用新房主配置',()=>{
  const model={id:'ai',name:'Gemini',provider:'compatible',model:'host-model',characterId:'gemini',apiKey:'PRIVATE-KEY',baseUrl:'https://private-provider.example/v1'},other={...model,id:'other',model:'guest-model'};
  const rooms=new Rooms({accounts:{},recordings:{},makeOptions(){},lobbyOptions:user=>({players:user.id===host.id?[model]:[other],playerIds:user.id===host.id?[model.id]:[]})});
  try{
    rooms.create(host);const room=rooms.require(host);rooms.join(viewer,room.id);
    let state=rooms.snapshot(room,viewer);assert.equal(state.lobby.players[0].model,'host-model');assert.equal(state.lobby.players[0].characterId,'gemini');
    assert(!JSON.stringify(state).includes('PRIVATE-KEY'));assert(!JSON.stringify(state).includes('private-provider'));
    assert.throws(()=>rooms.setLobby(viewer,{playerIds:[]}),/房主/);assert.throws(()=>rooms.setLobby(host,{playerIds:['other']}),/有效 AI/);
    rooms.setLobby(host,{playerIds:[]});assert.equal(rooms.snapshot(room,viewer).lobby.players.length,0);
    rooms.setLobby(host,{playerIds:['ai']});assert.equal(rooms.snapshot(room,viewer).lobby.players.length,1);
    rooms.leave(host);state=rooms.snapshot(room,viewer);assert.equal(state.hostId,viewer.id);assert.equal(state.lobby.players.length,0);
    rooms.setLobby(viewer,{playerIds:['other']});assert.equal(rooms.snapshot(room,viewer).lobby.players[0].model,'guest-model');
  }finally{rooms.close();}
});
