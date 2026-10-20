import test from 'node:test';
import assert from 'node:assert/strict';
import {createSoundEngine,createSoundEvents} from '../public/game-sounds.mjs';

test('音效在手势解锁后才建立音频节点，静音立即停止且偏好可持久保存',async()=>{
  const nodes=[],played=[],saved=new Map();let contexts=0;
  class Context{
    constructor(){contexts++;this.state='suspended';this.currentTime=1;this.destination={};}
    async resume(){this.state='running';}
    async close(){this.state='closed';}
    createOscillator(){const node={frequency:{},connect(){},disconnect(){},start(time){this.startAt=time;},stop(time){this.stopAt=time;if(time===undefined)this.onended?.();}};nodes.push(node);return node;}
    createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
  }
  const sound=createSoundEngine({Context,storage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)},isVisible:()=>true,onPlay:name=>played.push(name)});
  assert(!sound.play('correct'));assert.equal(contexts,0);await sound.unlock();assert(sound.play('correct'));assert.equal(nodes.length,3);assert(nodes.every(n=>n.stopAt>n.startAt));
  sound.setEnabled(false);assert(!sound.play('message'));assert.equal(saved.get('drawguess.soundEnabled'),'false');
  sound.setEnabled(true);await sound.unlock();assert(sound.play('message'));assert.equal(contexts,1);assert.deepEqual(played,['correct','message']);sound.close();
});

test('音效在后台或不支持 Web Audio 时安全静默，重复触发有节流',async()=>{
  let visible=false;class Context{constructor(){this.state='running';this.currentTime=1;}createOscillator(){return {frequency:{},connect(){},start(){},stop(){}};}createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){}};}}
  const sound=createSoundEngine({Context,storage:null,isVisible:()=>visible});await sound.unlock();assert(!sound.play('tap'));visible=true;assert(sound.play('tap'));assert(!sound.play('tap'));
  const unsupported=createSoundEngine({Context:null,storage:null});assert(!await unsupported.unlock());assert(!unsupported.play('finish'));
});

test('初次加载与重复轮询不会重放消息，自己的发送不会被当作新消息提醒',()=>{
  const events=createSoundEvents(),room={id:'r',messages:[{id:'old',kind:'chat',playerId:'ai'}]};
  assert.equal(events.update({room,viewerId:'me'}),null);assert.equal(events.update({room,viewerId:'me'}),null);
  room.messages.push({id:'own',kind:'chat',playerId:'me'});assert.equal(events.update({room,viewerId:'me'}),null);
  room.messages.push({id:'new',kind:'chat',playerId:'ai'});assert.equal(events.update({room,viewerId:'me'}),'message');assert.equal(events.update({room,viewerId:'me'}),null);
  room.aiChat={id:'job',status:'error'};assert.equal(events.update({room,viewerId:'me'}),'error');assert.equal(events.update({room,viewerId:'me'}),null);
});

test('阶段与本人判分提供不同提示，不根据其他玩家的隐藏答案提前播放猜中音效',()=>{
  const events=createSoundEvents(),room={id:'r',messages:[]},game={id:'g',index:0,turn:1,phase:'drawing',results:{me:{history:[]},other:{history:[]}}};
  events.update({room,viewerId:'me'});assert.equal(events.update({room,game,viewerId:'me'}),'start');
  game.phase='guessing';assert.equal(events.update({room,game,viewerId:'me'}),'guess');
  game.results.other.history.push({correct:true});assert.equal(events.update({room,game,viewerId:'me'}),null);
  game.results.me.history.push({correct:true});assert.equal(events.update({room,game,viewerId:'me'}),'correct');assert.equal(events.update({room,game,viewerId:'me'}),null);
  game.phase='reveal';assert.equal(events.update({room,game,viewerId:'me'}),'reveal');game.phase='finished';assert.equal(events.update({room,game,viewerId:'me'}),'finish');
});

test('倒计时仅对本轮需要操作的玩家提醒，5 秒内每秒一次且不重复',()=>{
  const events=createSoundEvents(),game={id:'g',index:0,turn:1,phase:'guessing',clockReceivedAt:100000,clock:{stage:'guess',serverNow:100000,deadline:106000},results:{me:{status:'waiting',solved:false}}};
  assert.equal(events.countdown(game,'me',100000),null);assert.equal(events.countdown(game,'me',101000),'tick');assert.equal(events.countdown(game,'me',101100),null);assert.equal(events.countdown(game,'me',106000),'timeout');assert.equal(events.countdown(game,'me',106100),null);
  assert.equal(events.countdown(game,'spectator',106000),null);game.results.me.status='submitted';assert.equal(events.countdown(game,'me',106000),null);
});
