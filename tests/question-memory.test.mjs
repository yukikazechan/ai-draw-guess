import test from 'node:test';
import assert from 'node:assert/strict';
import {Banter,battleBanterContext} from '../lib/banter.mjs';
import {Game} from '../lib/game.mjs';
import {questionMemory} from '../lib/question-memory.mjs';

const shape={type:'line',points:[[10,10],[100,100]],color:'#202633',width:5};
const bytes=Buffer.alloc(24);Buffer.from('89504e470d0a1a0a','hex').copy(bytes);bytes.writeUInt32BE(1000,16);bytes.writeUInt32BE(650,20);const image='data:image/png;base64,'+bytes.toString('base64');

test('本题连续三次互怼带上双方此前实际对白，失败重试不编造回应，新题不继承旧对白',async()=>{
  const players=[{id:'human',name:'玩家',human:true},{id:'ai',name:'AI'}],calls=[],published=[];let fail=false;
  const create=()=>new Banter({players,pairs:[],context:{answer:'雨伞'},run:async(p,prompt)=>{calls.push(prompt);if(fail)throw Error('接口失败');return {line:'回应编号'+calls.length};},publish:m=>published.push(m),touch(){}});
  const b=create();
  try{
    await b.challenge({banterId:b.id,targetId:'ai',text:'第一句：这是我提示得好'},'human');
    await b.challenge({banterId:b.id,targetId:'ai',text:'第二句：你刚才说什么？'},'human');
    assert(calls[1].includes('第一句：这是我提示得好'));assert(calls[1].includes('回应编号1'));assert(calls[1].includes('第二句：你刚才说什么？'));
    fail=true;await b.challenge({banterId:b.id,targetId:'ai',text:'第三句：接着刚才聊'},'human');assert.equal(b.status,'error');
    assert(calls[2].includes('回应编号1'));assert(calls[2].includes('回应编号2'));assert(!calls[2].includes('接口失败'));
    fail=false;await b.retry({banterId:b.id});assert.equal(b.status,'complete');assert.equal(published.length,6);
    assert(calls[3].includes('第一句：这是我提示得好'));assert(calls[3].includes('回应编号2'));assert(!calls[3].includes('回应编号3'));
    const next=create();await next.challenge({banterId:next.id,targetId:'ai',text:'新题开始'},'human');assert(!calls.at(-1).includes('第一句：这是我提示得好'));next.stop();
  }finally{b.stop();}
});

test('三轮补画与猜题记得先前提示和真实猜词，猜手上下文不包含答案或其他选手私密信息',async()=>{
  const players=[{id:'artist',name:'画手'},{id:'a',name:'甲'},{id:'b',name:'乙'}],calls=[];let version=0;
  const game=new Game({players,human:false,mode:'battle',category:'物品',words:Array.from({length:3},()=>({answer:'雨伞',category:'物品'})),orderRandom:n=>n-1,hintMode:'visual',revealDelay:0,run:async(p,prompt,img)=>{
    calls.push({id:p.id,prompt,img});
    if(!img){version++;return version===1?{shapes:[shape]}:{undo:0,append:[],hint:version===2?'第二轮公开旧提示':'第三轮公开新提示',hints:{a:version===2?'甲的旧私下提示':'甲的新私下提示',b:'乙的专属私下提示'}};}
    return {guess:`${p.id}第${version}轮误读`,reason:`${p.id}独立理由${version}`};
  }});
  try{
    await game.next();await game.beginGuess({image});await game.revise();await game.beginGuess({image});await game.revise();await game.beginGuess({image});
    assert.equal(game.turn,3);assert.equal(game.phase,'reveal');
    const redraw=calls.filter(c=>!c.img).at(-1).prompt;
    for(const text of ['第二轮公开旧提示','甲的旧私下提示','乙的专属私下提示','a独立理由1','a独立理由2','b独立理由2'])assert(redraw.includes(text),text);
    assert(redraw.includes('不要反复换说法重复同一条提示'));
    const guess=calls.filter(c=>c.img&&c.id==='a'&&c.prompt.startsWith('你在玩你画我猜')).at(-1).prompt;
    for(const text of ['第二轮公开旧提示','第三轮公开新提示','甲的旧私下提示','甲的新私下提示','a独立理由1','a独立理由2'])assert(guess.includes(text),text);
    for(const secret of ['雨伞','乙的专属私下提示','b独立理由','b第2轮误读'])assert(!guess.includes(secret),secret);
    const context=battleBanterContext(game);assert(context.questionMemory.hints.some(h=>h.text.includes('第二轮公开旧提示')));assert(context.questionMemory.hints.some(h=>h.text.includes('甲的旧私下提示')));
    assert(!JSON.stringify(game.snapshot()).includes('本题记忆（'));
    await game.next();assert.deepEqual(questionMemory(game,game.artist.id),{hints:[],guesses:[]});
    game.hintMode='none';game.conversation.push({index:game.index,kind:'hint',turn:1,text:'不该发送的提示'});assert.deepEqual(questionMemory(game,game.artist.id).hints,[]);
  }finally{game.finish();}
});
