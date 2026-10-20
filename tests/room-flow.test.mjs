import test from 'node:test';
import assert from 'node:assert/strict';
import {createRoomClient} from '../public/room-client.mjs';
import {Rooms} from '../lib/rooms.mjs';
import {Banter} from '../lib/banter.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Socket{close(){} }
const url={protocol:'http:',host:'localhost'};

test('慢速 AI 选择同步不阻止立即开局，迟到的准备状态不能覆盖比赛',async()=>{
  const old={id:'room',version:1,lobby:{playerIds:[]},game:null};let release;
  const calls=[],client=createRoomClient({Socket,url,request:async(path,data)=>{
    calls.push({path,data});
    if(path==='/api/rooms/state')return {room:old};
    if(path==='/api/rooms/lobby')return new Promise(resolve=>release=resolve);
    if(path==='/api/rooms/start')return {room:{...old,version:2,game:{id:'match',phase:'drawing'}}};
  }});
  try{
    await client.enter();const pending=client.lobby({playerIds:['ai']});await tick();
    await client.start({playerIds:['ai']});assert.equal(client.room.game.id,'match');
    release({room:{...old,version:100}});await pending;assert.equal(client.room.game.id,'match');
    assert.equal(calls.find(c=>c.path==='/api/rooms/lobby').data.roomId,'room');
  }finally{client.suspend();}
});

test('连续修改 AI 选择时合并尚未发送的旧选择，最后一次选择必定最后应用',async()=>{
  const room={id:'room',version:1,game:null};let release;const selections=[];
  const client=createRoomClient({Socket,url,request:async(path,data)=>{
    if(path==='/api/rooms/state')return {room};
    if(path==='/api/rooms/lobby'){selections.push(data.playerIds);if(selections.length===1)return new Promise(resolve=>release=resolve);return {room:{...room,version:3,lobby:{playerIds:data.playerIds}}};}
  }});
  try{
    await client.enter();const first=client.lobby({playerIds:['first']});await tick();
    const obsolete=client.lobby({playerIds:['obsolete']}),last=client.lobby({playerIds:['last']});
    release({room:{...room,version:2,lobby:{playerIds:['first']}}});await Promise.all([first,obsolete,last]);
    assert.deepEqual(selections,[['first'],['last']]);assert.deepEqual(client.room.lobby.playerIds,['last']);
  }finally{client.suspend();}
});

test('切换房间后，旧房间聊天和准备请求不能误发到新房间',()=>{
  const user={id:'host',name:'房主'},rooms=new Rooms({accounts:{},recordings:{},makeOptions(){}});
  try{
    const old=rooms.create(user);rooms.leave(user);rooms.create(user);const room=rooms.require(user);
    assert.throws(()=>rooms.chat(user,{roomId:old.id,text:'迟到消息'}),/房间已变更/);
    assert.throws(()=>rooms.setLobby(user,{roomId:old.id,playerIds:[]}),/房间已变更/);
    assert.equal(rooms.snapshot(room,user).messages.length,0);
  }finally{rooms.close();}
});

test('被点名观众离开后自动结束等待，保留已发消息且可以继续本题互动',async()=>{
  const host={id:'host',name:'房主'},viewer={id:'viewer',name:'观众'};
  const rooms=new Rooms({accounts:{charge(){},own(){}},recordings:{attach(){}},makeOptions:()=>({players:[{id:'ai',name:'AI'}],category:'动物',orderRandom:n=>n-1,run:async()=>({line:'继续聊。'})})});
  try{
    rooms.create(host);const room=rooms.require(host);await rooms.start(host,{banter:true});rooms.join(viewer,room.id);
    const g=room.game;g.reveal();await g.banter.task;
    const stamp={gameId:g.id,index:g.index,turn:g.turn,banterId:g.banter.id};
    await rooms.action(host,{...stamp,action:'banter-challenge',targetId:viewer.id,text:'观众怎么看？'});await g.banter.task;
    assert.equal(g.banter.status,'waiting-human');rooms.leave(viewer);await tick();
    assert.equal(g.phase,'reveal');assert.equal(g.banter.status,'complete');assert.equal(g.banter.exchanges[0].status,'skipped');assert.equal(g.banter.exchanges[0].reply,'');
    assert(g.conversation.some(m=>m.text==='观众怎么看？'));assert.equal(g.players.length,2);
    await assert.rejects(rooms.action(host,{...stamp,action:'banter-challenge',targetId:viewer.id,text:'已经走了'}),/已离开/);
    await rooms.action(host,{...stamp,action:'banter-challenge',targetId:'ai',text:'那你说呢？'});await g.banter.task;assert.equal(g.banter.status,'complete');assert(g.banter.exchanges.at(-1).reply);
  }finally{rooms.close();}
});

test('AI 开口期间收件人离开，完成后不会再等待离开的真人',async()=>{
  let resolve;const present=new Set(['human']),published=[];
  const banter=new Banter({players:[{id:'ai',name:'AI'},{id:'human',name:'观众',human:true}],pairs:[{fromId:'ai',toId:'human',kind:'human-answer'}],context:{},humanAvailable:id=>present.has(id),run:()=>new Promise(done=>resolve=done),publish:line=>published.push(line),touch(){}});
  try{const task=banter.start();present.delete('human');banter.humanLeft('human');resolve({line:'你怎么看？'});await task;assert.equal(banter.status,'complete');assert.equal(banter.exchanges[0].status,'skipped');assert.equal(published.length,1);}
  finally{banter.stop();}
});
