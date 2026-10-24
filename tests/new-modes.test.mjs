import test from 'node:test';
import assert from 'node:assert/strict';
import {UndercoverGame,undercoverPrompt} from '../lib/undercover.mjs';
import {Rooms} from '../lib/rooms.mjs';
import {MatchRecording} from '../lib/recording.mjs';
import {undercoverStageMarkup,undercoverActionMarkup} from '../public/undercover-view.mjs';
import {roomComposerState} from '../public/room-composer.mjs';
const humans=['a','b','c','d'].map(id=>({id,name:id,human:true}));
const create=extra=>new UndercoverGame({players:[],human:false,humans,rng:n=>n-1,pairs:[['苹果','梨']],reviewDelay:60000,recoveryDelay:0,...extra});
const describeAll=g=>{let n=0;while(g.phase==='undercover-speak'){assert(n++<14);g.describe(g.speakerId,'这是一个生活中常见的东西。');}};
const cast=(g,choices)=>{for(const [id,target] of Object.entries(choices))g.vote(id,target);};
const shape={type:'rect',x:111,y:222,w:120,h:90,color:'#202633',width:5};

test('卧底仅向本人发送词语；AI 提示没有另一阵营的词或当前投票，观众看不到私词',()=>{
  const g=create();try{
    g.next();const spy=[...g.assignments].find(([,a])=>a.role==='undercover')[0],civilian=humans.find(p=>p.id!==spy).id,secret=g.assignments.get(spy).word;
    assert.equal(g.snapshot(civilian).undercover.myWord,g.assignments.get(civilian).word);
    assert(!JSON.stringify(g.snapshot(civilian)).includes(secret));assert(!JSON.stringify(g.snapshot('observer')).includes(secret));assert.equal(g.snapshot('observer').undercover.myWord,null);
    assert(!undercoverPrompt(g,civilian,'describe').includes(secret));assert(!g.snapshot(civilian).players.some(p=>p.role));
    assert.throws(()=>g.describe(civilian,'抢先发言'),/轮到/);assert.throws(()=>g.describe(g.speakerId,g.assignments.get(g.speakerId).word),/不能直接/);
    describeAll(g);g.vote('a','b','私下理由');assert(!JSON.stringify(g.snapshot('c')).includes('私下理由'));assert(!undercoverPrompt(g,'c','vote').includes('私下理由'));assert.throws(()=>g.vote('a','c'),/已经提交/);
  }finally{g.finish();}
});
test('卧底投票淘汰、平民胜利和结算全部身份词语准确',()=>{
  const g=create();try{g.next();describeAll(g);cast(g,{a:'b',b:'a',c:'a',d:'a'});assert.equal(g.phase,'finished');assert.equal(g.winner,'civilian');assert.equal(g.alive.has('a'),false);assert.equal(Object.keys(g.snapshot('observer').undercover.assignments).length,4);}finally{g.finish();}
});
test('平票只复投一次，仍平无人出局；候选限制、自己不能投自己',()=>{
  const g=create();try{g.next();describeAll(g);assert.throws(()=>g.vote('a','a'),/其他有效/);cast(g,{a:'b',b:'a',c:'a',d:'b'});assert.equal(g.phase,'undercover-vote');assert.equal(g.voteAttempt,1);assert.deepEqual(g.candidates,['a','b']);assert.throws(()=>g.vote('c','d'),/有效/);cast(g,{a:'b',b:'a',c:'a',d:'b'});assert.equal(g.phase,'undercover-review');assert.equal(g.alive.size,4);assert.equal(g.history.length,2);g.expire();assert.equal(g.index,1);assert.equal(g.phase,'undercover-speak');}finally{g.finish();}
});
test('卧底达到人数优势获胜，已出局不能描述或投票',()=>{
  const g=create();try{g.next();describeAll(g);cast(g,{a:'b',b:'c',c:'b',d:'b'});assert.equal(g.phase,'undercover-review');g.expire();describeAll(g);assert.throws(()=>g.vote('b','a'),/不能投票/);cast(g,{a:'c',c:'d',d:'c'});assert.equal(g.winner,'undercover');}finally{g.finish();}
});
test('发言超时跳过、投票超时弃权；8 轮无胜负结束为平局',()=>{
  const g=create();try{g.next();for(let round=0;round<8;round++){while(g.phase==='undercover-speak')g.expire();g.expire();if(round<7){assert.equal(g.phase,'undercover-review');g.expire();}}assert.equal(g.phase,'finished');assert.equal(g.winner,'draw');assert.equal(g.history.length,8);}finally{g.finish();}
});
test('AI 发言会收到本人词和公开记忆，迟到响应不会改变结束的游戏',async()=>{
  let resolve,prompt;const g=create({humans:[],players:humans.map(p=>({...p,human:false})),run:(_p,text)=>{prompt=text;return new Promise(r=>resolve=r);}});
  g.next();const before=g.conversation.length;g.finish();resolve({description:'迟到的描述'});await g.workTask;assert.equal(g.phase,'finished');assert.equal(g.conversation.length,before+1);assert(!JSON.stringify(g.snapshot()).includes('迟到的描述'));assert(prompt.includes('你的词是'));
});
test('真人与 AI 混合卧底按序发言和投票，记录器跟随状态转换不打断流程',async()=>{
  let g;const calls=[];g=create({humans:[humans[3]],players:humans.slice(0,3).map(p=>({...p,human:false})),run:async(p,prompt)=>{calls.push({id:p.id,prompt});return prompt.includes('本轮匿名投票')?{targetId:p.id==='d'?'a':'d',reason:'描述与其他人不一致'}:{description:'生活中经常能见到它'};}});
  try{new MatchRecording(g);g.next();for(let i=0;i<20&&g.phase==='undercover-speak';i++){if(g.speakerId==='d')g.describe('d','它有很多用途');else await g.workTask;}
    assert.equal(g.phase,'undercover-vote');g.vote('d','a');await g.workTask;assert.equal(g.phase,'finished');assert.equal(g.winner,'civilian');assert.equal(calls.length,6);
    for(const call of calls){const other=[...g.assignments.values()].find(a=>a.word!==g.assignments.get(call.id).word).word;assert(!call.prompt.includes(other));}
  }finally{g.finish();}
});
test('卧底可以记录与导出，页面转义词语和发言；观战与出局者聊天受限',()=>{
  const g=create({pairs:[['<img src=x>','梨']]});try{const rec=new MatchRecording(g);g.next();assert(rec.events.length);const s=g.snapshot('a');assert(!undercoverStageMarkup(s).includes('<img'));assert(undercoverActionMarkup(s).includes('undercoverDescribe'));assert(roomComposerState({game:g.snapshot('observer'),members:[]},'observer').blocked);g.finish();assert.equal(rec.export().recording.status,'finished');}finally{g.finish();}
});
test('联机接龙每人独立任务和草稿、不能冒名交卷，中途加入只观战；全部完成才揭晓',async()=>{
  const rooms=new Rooms({accounts:{charge(){},own(){}},recordings:{attach:g=>new MatchRecording(g)},makeOptions:()=>({players:[],category:'动物',passDelay:60000}),lobbyOptions:()=>({players:[],playerIds:[]})});
  try{
    rooms.create(humans[0]);const room=rooms.require(humans[0]);for(const p of humans.slice(1))rooms.join(p,room.id);
    await rooms.start(humans[0],{mode:'relay'});const g=room.game,outsider={id:'watcher',name:'观众'};rooms.join(outsider,room.id);
    assert.equal(g.mode,'relay');const first=g.snapshot('a').relay.myTask,second=g.snapshot('b').relay.myTask;assert.notEqual(first.chainId,second.chainId);
    assert.equal(g.snapshot(outsider.id).relay.myTask,null);assert.deepEqual(g.snapshot('a').chains,[]);
    rooms.drawing(humans[0],{gameId:g.id,index:g.index,chainId:first.chainId,shapes:[shape]});assert.equal(g.snapshot('a').relay.myTask.draft[0].x,111);assert.deepEqual(g.snapshot('b').relay.myTask.draft,[]);
    await assert.rejects(rooms.action(humans[0],{gameId:g.id,index:g.index,action:'relay-submit',stage:g.index,chainId:second.chainId,shapes:[shape]}),/交卷/);
    await assert.rejects(rooms.action(outsider,{gameId:g.id,index:g.index,action:'relay-submit',stage:g.index,chainId:first.chainId,shapes:[shape]}),/观战/);
    for(let stage=0;stage<4;stage++){
      for(const p of humans){const task=g.snapshot(p.id).relay.myTask;await rooms.action(p,{gameId:g.id,index:g.index,action:'relay-submit',stage:g.index,chainId:task.chainId,shapes:[shape],guess:`${p.id} 的接龙词`});}
      assert.equal(g.phase,'relay-pass');g.advance();
    }
    assert.equal(g.phase,'finished');assert.equal(g.completed,true);assert.equal(g.snapshot('watcher').chains.length,4);assert(g.chains.every(c=>c.steps.length===4));assert.equal(g.snapshot('a').relay.showcase,null);
  }finally{rooms.close();}
});
test('联机接龙超时提交已画内容，空白棒次留空，不公开他人的草稿',async()=>{
  const rooms=new Rooms({accounts:{charge(){},own(){}},recordings:{attach(){}},makeOptions:()=>({players:[],category:'动物',passDelay:60000})});
  try{rooms.create(humans[0]);const room=rooms.require(humans[0]);rooms.join(humans[1],room.id);await rooms.start(humans[0],{mode:'relay'});const g=room.game,task=g.snapshot('a').relay.myTask;
    rooms.drawing(humans[0],{gameId:g.id,index:0,chainId:task.chainId,shapes:[shape]});g.clock.deadline=0;rooms.expire(room);await new Promise(r=>setImmediate(r));assert.equal(g.tasks.get('a').status,'submitted');assert.equal(g.tasks.get('b').status,'skipped');assert.equal(g.phase,'relay-pass');
  }finally{rooms.close();}
});
