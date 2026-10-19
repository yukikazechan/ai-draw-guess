import test from 'node:test';
import assert from 'node:assert/strict';
import {Rooms,RoomGame} from '../lib/rooms.mjs';
import {messageBody,messageLabel} from '../public/conversation.mjs';
import {createRoomClient} from '../public/room-client.mjs';

const host={id:'host',name:'房主'},player={id:'player',name:'玩家'},viewer={id:'viewer',name:'观众'};
function createRooms(){
  const ownership=[];
  const rooms=new Rooms({accounts:{charge(){},own:(game,id)=>ownership.push([game,id])},recordings:{attach(){}},makeOptions:()=>({players:[],category:'动物',orderRandom:n=>n-1,revealDelay:0})});
  rooms.create(host);const room=rooms.require(host);rooms.join(player,room.id);
  return {rooms,room,ownership};
}

test('中途加入只观战，不能提交或控制比赛，离开不会结束比赛；留房自动加入下一局',async()=>{
  const {rooms,room,ownership}=createRooms();
  try{
    await rooms.start(host,{});const game=room.game,deadline=game.clock.deadline,roster=game.players.map(p=>p.id);
    const watched=rooms.join(viewer,room.id);
    assert.equal(watched.game.viewerRole,'spectator');assert.equal(watched.members.find(p=>p.id===viewer.id).role,'spectator');
    assert.equal(watched.game.answer,null);assert(!watched.game.recordingEnabled);assert.deepEqual(game.players.map(p=>p.id),roster);assert.equal(game.clock.deadline,deadline);
    assert(!ownership.some(([id,user])=>id===game.id&&user===viewer.id));
    const stamp={gameId:game.id,index:game.index,turn:game.turn};
    for(const action of ['guess','pass','draw-done','revise','next','finish','reveal'])await assert.rejects(rooms.action(viewer,{...stamp,action,guess:'答案'}),/观战/);
    for(const action of ['banter-challenge','banter-reply','banter-retry'])await assert.rejects(rooms.action(viewer,{...stamp,action}),/互怼环节/);
    assert.throws(()=>rooms.drawing(viewer,{...stamp,shapes:[]}),/画手/);
    rooms.leave(viewer);assert.equal(game.phase,'drawing');rooms.join(viewer,room.id);
    rooms.chat(viewer,{text:'下局一起玩！',name:'伪造房主',playerId:host.id});
    assert.equal(rooms.snapshot(room,host).messages[0].playerId,viewer.id);assert.equal(rooms.snapshot(room,player).messages[0].name,'观众');assert(rooms.snapshot(room,host).messages[0].spectator);
    game.finish();await rooms.action(host,{...stamp,action:'home'});assert.equal(room.game,null);
    assert.equal(rooms.snapshot(room,viewer).members.find(p=>p.id===viewer.id).role,'player');assert.equal(room.messages.length,1);
    await rooms.start(host,{});assert(room.game.players.some(p=>p.human&&p.id===viewer.id));assert.equal(rooms.snapshot(room,viewer).game.viewerRole,'player');
    assert(ownership.some(([id,user])=>id===room.game.id&&user===viewer.id));
  }finally{rooms.close();}
});

test('一位真人加 AI 的房间，观众仍不能提前看到正确回答或私人提示',async()=>{
  const game=new RoomGame({players:[{id:'ai',name:'AI'},{id:'other-ai',name:'另一位 AI'}],humans:[{...host,human:true}],human:false,mode:'battle',category:'动物',orderRandom:n=>n-1,revealDelay:0});
  try{
    await game.next();game.phase='guessing';game.record('ai',game.word.answer,'秘密正确理由',80,false);game.record('other-ai','错误答案','错误理由',20,false);game.settle();
    // The sole participant keeps the original early-disclosure behavior.
    assert.equal(game.snapshot(host.id).results.ai.history.length,1);
    game.privateHints={ai:'专属秘密提示'};
    const state=game.snapshot(viewer.id);assert.equal(state.answer,null);assert.deepEqual(state.results.ai.history,[]);
    assert(!JSON.stringify(state).includes('秘密正确理由'));assert(!JSON.stringify(state).includes('专属秘密提示'));
    game.reveal();assert.equal(game.snapshot(viewer.id).answer,game.word.answer);assert.equal(game.snapshot(viewer.id).results.ai.history.length,1);
  }finally{game.finish();}
});

test('房间聊天校验内容、限速、保留最近 200 条，并转义 HTML；成员上限仍是 8 人',()=>{
  const {rooms,room}=createRooms();
  try{
    rooms.join(viewer,room.id);
    for(const text of ['', ' ', 'x'.repeat(201),null,{}])assert.throws(()=>rooms.chat(viewer,{text}),/1–200/);
    rooms.chat(viewer,{text:'<img src=x onerror=alert(1)>'});const message=room.messages[0];
    assert(messageBody(message).includes('&lt;img'));assert.equal(messageLabel(message),'聊天');
    assert.throws(()=>rooms.chat(viewer,{text:'刷屏'}),/太快/);
    assert.throws(()=>rooms.chat({id:'outsider'},{text:'不在房间'}),/加入房间/);
    for(let i=0;i<205;i++){room.members.get(viewer.id).chatAt=0;rooms.chat(viewer,{text:String(i)});}
    assert.equal(room.messages.length,200);assert.equal(room.messages[0].text,'5');assert.equal(room.messages.at(-1).text,'204');
    for(let i=0;i<5;i++)rooms.join({id:'extra-'+i,name:'额外玩家'},room.id);
    assert.throws(()=>rooms.join({id:'ninth',name:'第九位'},room.id),/8 位真人/);
  }finally{rooms.close();}
});

test('邀请自动加入失败会返回明确原因，重试后可以加入；已有其他房间不会悄悄忽略新邀请',async()=>{
  let stored=null,fail=true;const joined=[];
  class Socket{close(){} }
  const client=createRoomClient({url:{protocol:'http:',host:'localhost'},Socket,request:async(path,data)=>{
    if(path==='/api/rooms/state')return {room:stored};
    if(path==='/api/rooms/join'){joined.push(data.code);if(fail)throw new Error('房间不存在或已关闭。');stored={id:data.code,version:1,members:[],game:null};return {room:stored};}
    if(path==='/api/rooms/chat')return {ok:true};
  }});
  try{
    await assert.rejects(client.enter('ABCDEF12'),/不存在/);assert.equal(client.room,null);fail=false;
    await client.enter('ABCDEF12');assert.equal(client.room.id,'ABCDEF12');assert.deepEqual(joined,['ABCDEF12','ABCDEF12']);
    await assert.rejects(client.enter('1234ABCD'),/先离开/);assert.equal(client.room.id,'ABCDEF12');assert.equal(joined.length,2);
  }finally{client.suspend();}
});
