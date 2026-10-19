import test from 'node:test';
import assert from 'node:assert/strict';
import {Rooms} from '../lib/rooms.mjs';

const shape={type:'rect',x:100,y:100,w:200,h:200,color:'#202633',width:5};
const append={type:'rect',x:400,y:200,w:50,h:30,color:'#202633',width:5};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

async function createRoom(count=1){
  let draws=0;const users=Array.from({length:count},(_,i)=>({id:`human-${i}`,name:`玩家 ${i+1}`}));
  const rooms=new Rooms({accounts:{charge(){},own(){}},recordings:{attach(){}},makeOptions:()=>({players:[{id:'ai',name:'Gemini',characterId:'gemini',provider:'compatible'}],category:'动物',rounds:1,orderRandom:n=>n===count+1?0:n-1,run:async()=>++draws===1?{shapes:[shape]}:{undo:0,append:[append],hint:'留意右边的轮廓。',hints:{'human-0':'看旁边的小方框。'}}})});
  rooms.create(users[0]);const room=rooms.require(users[0]);for(const user of users.slice(1))rooms.join(user,room.id);
  await rooms.start(users[0],{});await tick();room.game.revealDelay=0;
  return {rooms,room,users,game:room.game,draws:()=>draws};
}

for(const count of [1,2])test(`第二轮展示定时器提前 1ms 到达时会重新排程：${count} 位真人`,async t=>{
  let now=100000;const scheduled=[];
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'setTimeout',(fn,delay)=>{const timer={fn,delay,unref(){}};scheduled.push(timer);return timer;});
  t.mock.method(globalThis,'clearTimeout',timer=>{if(timer)timer.cancelled=true;});
  const {rooms,room,users,game:g,draws}=await createRoom(count);
  try{
    assert.equal(g.phase,'ready');now=g.clock.deadline;scheduled.at(-1).fn();await tick();assert.equal(g.phase,'guessing');
    if(count===1){now=g.clock.deadline;scheduled.at(-1).fn();assert(g.results[users[0].id].history[0].timedOut);}
    else for(const user of users)g.humanGuess('错误词',false,user.id);
    assert.equal(g.phase,'review');now=g.clock.deadline;scheduled.at(-1).fn();await tick();
    assert.equal(g.turn,2);assert.equal(g.phase,'ready');assert.equal(draws(),2);assert.match(g.hint,/留意右边/);
    const secondDisplay=scheduled.at(-1),deadline=g.clock.deadline,registered=scheduled.length;
    now=deadline-1;secondDisplay.fn();
    assert.equal(g.phase,'ready');assert.equal(g.clock.deadline,deadline);
    assert.equal(scheduled.length,registered+1,'提前触发不能丢弃后续切换，必须重新安排剩余 1ms');
    assert.equal(scheduled.at(-1).delay,1);
    now=deadline;scheduled.at(-1).fn();await tick();
    assert.equal(g.phase,'guessing');assert.equal(g.turn,2);assert.equal(g.clock.stage,'guess');
    for(const user of users)assert.equal(g.results[user.id].status,'waiting');
  }finally{rooms.close();}
});

test('失效的展示回调不能操作后续猜词阶段',async t=>{
  let now=100000;const scheduled=[];
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'setTimeout',(fn,delay)=>{const timer={fn,delay,unref(){}};scheduled.push(timer);return timer;});
  t.mock.method(globalThis,'clearTimeout',()=>{});
  const {rooms,game:g}=await createRoom();
  try{
    const display=scheduled.at(-1);now=g.clock.deadline;display.fn();await tick();assert.equal(g.phase,'guessing');
    const guessing=scheduled.at(-1);now=g.clock.deadline;display.fn();
    assert.equal(g.phase,'guessing');assert.equal(g.results['human-0'].pending,undefined);
    guessing.fn();assert.equal(g.phase,'review');
  }finally{rooms.close();}
});

test('真实定时器贯通首轮、AI 补画和第二轮猜题，不需要房主继续点击',{timeout:15000},async()=>{
  const {rooms,users,game:g,draws}=await createRoom();
  const until=async predicate=>{const end=Date.now()+10000;while(Date.now()<end){if(predicate())return;await new Promise(r=>setTimeout(r,15));}throw new Error(`卡在 ${g.phase}，turn=${g.turn}`);};
  try{
    await until(()=>g.phase==='guessing');g.humanGuess('',true,users[0].id);assert.equal(g.phase,'review');
    await until(()=>g.phase==='guessing'&&g.turn===2);assert.equal(draws(),2);assert.match(g.myHint||g.privateHints[users[0].id],/小方框/);
    g.humanGuess(g.word.answer,false,users[0].id);
    assert.equal(g.phase,'reveal');assert.deepEqual(g.results[users[0].id].history.map(h=>h.turn),[1,2]);assert.equal(g.results[users[0].id].points,2);
  }finally{rooms.close();}
});
