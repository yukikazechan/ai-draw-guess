import test from 'node:test';
import assert from 'node:assert/strict';
import {Rooms} from '../lib/rooms.mjs';
import {spectatorProgress} from '../public/room-composer.mjs';
import {conversationUpdateNotice} from '../public/conversation.mjs';

test('观战者接任房主后仍能继续下一题、查看结果和重试作画，普通观众没有控制权',()=>{
  for(const phase of ['drawing','guessing','review','reveal','draw-error']){
    const g={phase,index:0,total:2};assert.equal(spectatorProgress(g,false).action,'');
    const control=spectatorProgress(g,true);
    assert.equal(control.action,phase==='reveal'?'next':phase==='draw-error'?'retry-draw':'');
  }
  assert.equal(spectatorProgress({phase:'reveal',index:1,total:2},true).text,'查看结果');
});

test('查看历史时，同一条 AI 等待消息成功、失败或取消后都有新回应提醒',()=>{
  const pending={id:'ai-response:1',delivery:'pending',text:'正在回应…'};
  for(const delivery of [undefined,'error','cancelled'])assert.equal(conversationUpdateNotice([pending],[{...pending,delivery,text:'结果'}]),'有新回应 ↓');
  assert.equal(conversationUpdateNotice([pending],[{...pending}]),'');
  assert.equal(conversationUpdateNotice([pending],[pending,{id:'another',text:'新消息'}]),'有新消息 ↓');
  assert.equal(conversationUpdateNotice([{...pending,delivery:'error'}],[pending]),'');
});

test('准备下一局保留手选 AI 与纯真人选择，换房主后才换用对应配置',async()=>{
  const host={id:'host',name:'房主'},guest={id:'guest',name:'玩家'};
  const models=[{id:'default',name:'默认 AI'},{id:'manual',name:'手选 AI'}];
  const rooms=new Rooms({accounts:{charge(){},own(){},get:id=>id===host.id?host:guest},recordings:{attach(){}},lobbyOptions:user=>({players:models,playerIds:[user.id===host.id?'default':'manual']}),makeOptions:(_user,data)=>({players:models.filter(p=>data.playerIds.includes(p.id)),category:'动物',orderRandom:n=>n-1,revealDelay:0})});
  try{
    rooms.create(host);const room=rooms.require(host);rooms.join(guest,room.id);
    for(const ids of [['manual'],[]]){
      rooms.setLobby(host,{playerIds:ids});await rooms.start(host,{playerIds:ids});const g=room.game;g.finish();
      await rooms.action(host,{gameId:g.id,index:g.index,turn:g.turn,action:'home'});
      assert.deepEqual(room.lobby.playerIds,ids);
    }
    await rooms.start(host,{playerIds:['default']});let g=room.game;room.hostId=guest.id;g.finish();
    await rooms.action(guest,{gameId:g.id,index:g.index,turn:g.turn,action:'home'});assert.deepEqual(room.lobby.playerIds,['manual']);
    await rooms.start(guest,{playerIds:['manual']});g=room.game;room.hostId=host.id;g.finish();
    rooms.setLobby(host,{playerIds:[]});await rooms.action(host,{gameId:g.id,index:g.index,turn:g.turn,action:'home'});
    assert.deepEqual(room.lobby.playerIds,[],'接任者在结果页已调整的选择不能被默认值覆盖');
  }finally{rooms.close();}
});
