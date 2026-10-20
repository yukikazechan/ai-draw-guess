import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomGame} from '../lib/rooms.mjs';
import {Game} from '../lib/game.mjs';
import {renderRelayDrawing} from '../lib/relay-renderer.mjs';
const shapes=[{type:'rect',x:100,y:100,w:200,h:120,color:'#202633',width:5}];

test('未猜中者只见错误回答；猜中者和画手可见已判分答案；下一轮仍保护正确答案',async()=>{
 let g;g=new RoomGame({players:[{id:'hit-ai',name:'正确 AI',provider:'compatible'},{id:'miss-ai',name:'错误 AI',provider:'compatible'}],humans:['artist','wrong-human','right-human'].map(id=>({id,name:id,human:true})),human:false,mode:'battle',category:'动物',orderRandom:n=>n-1,revealDelay:0,run:async p=>({guess:p.id==='hit-ai'?g.word.answer:'错误动物',reason:p.id==='hit-ai'?'正确理由含 '+g.word.answer:'误读轮廓',confidence:88})});
 try{
  await g.next();await g.beginGuess({shapes,image:renderRelayDrawing(shapes)});
  g.humanGuess('玩家错误答案',false,'wrong-human');g.humanGuess(g.word.answer,false,'right-human');assert.equal(g.phase,'review');
  const blind=g.snapshot('wrong-human'),solved=g.snapshot('right-human'),artist=g.snapshot('artist');
  assert.equal(blind.answer,null);assert.deepEqual(blind.results['hit-ai'].history,[]);assert.deepEqual(blind.results['right-human'].history,[]);
  assert(blind.results['hit-ai'].solved);assert.equal(blind.results['miss-ai'].history[0].guess,'错误动物');
  assert(!JSON.stringify(blind).includes(g.word.answer));assert(!JSON.stringify(blind).includes('正确理由含'));
  assert.equal(solved.answer,g.word.answer);assert.equal(solved.results['hit-ai'].history[0].guess,g.word.answer);assert.equal(artist.results['hit-ai'].history[0].guess,g.word.answer);
  assert(solved.conversation.some(m=>m.playerId==='hit-ai'&&m.kind==='guess'));assert(!blind.conversation.some(m=>m.playerId==='hit-ai'&&m.kind==='guess'));
  await g.revise();assert.equal(g.snapshot('wrong-human').results['hit-ai'].history.length,0);assert.equal(g.snapshot('wrong-human').results['miss-ai'].history.length,1);
  g.privateHints={'wrong-human':'仅给未猜中的人'};g.logHints();assert(!JSON.stringify(g.snapshot('right-human')).includes('仅给未猜中的人'));
  g.reveal();assert.equal(g.snapshot('wrong-human').results['hit-ai'].history[0].guess,g.word.answer);
 }finally{g.finish();}
});

for(const [name,GameClass,humanId] of [['非联机人机比赛',Game,'human'],['单真人联机房间',RoomGame,'room-human']])test(`${name}未猜中时隐藏正确回答和理由，补画不泄露，猜中后公开`,async()=>{
 let g;g=new GameClass({players:[{id:'artist-ai',name:'画手 AI',provider:'compatible'},{id:'hit-ai',name:'正确 AI',provider:'compatible'},{id:'miss-ai',name:'错误 AI',provider:'compatible'}],...(GameClass===RoomGame?{human:false,humans:[{id:humanId,name:'玩家',human:true}]}:{human:true}),mode:'battle',category:'动物',orderRandom:n=>n-1,revealDelay:0,run:async(p,_prompt,image)=>image?{guess:p.id==='hit-ai'?g.word.answer:'错误动物',reason:p.id==='hit-ai'?'秘密正确理由 '+g.word.answer:'误读轮廓',confidence:88}:{shapes}});
 const snapshot=()=>g.snapshot(humanId);
 const assertHidden=()=>{
  const state=snapshot();assert.equal(state.answer,null);assert.deepEqual(state.results['hit-ai'].history,[]);
  assert(state.results['hit-ai'].solved);assert.equal(state.results['miss-ai'].history[0].guess,'错误动物');
  assert.equal(state.results[humanId].history[0].guess,'玩家错误答案');
  assert(!JSON.stringify(state).includes(g.word.answer));assert(!JSON.stringify(state).includes('秘密正确理由'));
  assert(!state.conversation.some(m=>m.kind==='guess'&&m.playerId==='hit-ai'));
 };
 try{
  await g.next();g.reveal();await g.next();assert.equal(g.artist.id,'artist-ai');
  await g.beginGuess({image:renderRelayDrawing(shapes)});g.humanGuess('玩家错误答案',false,humanId);assert.equal(g.phase,'review');assertHidden();
  await g.revise();assert.equal(g.turn,2);assertHidden();
  await g.beginGuess({image:renderRelayDrawing(shapes)});assertHidden();
  g.humanGuess(g.word.answer,false,humanId);assert.equal(g.phase,'review');
  const solved=snapshot();assert.equal(solved.answer,g.word.answer);assert.equal(solved.results['hit-ai'].history[0].guess,g.word.answer);
  assert(solved.conversation.some(m=>m.kind==='guess'&&m.playerId==='hit-ai'&&m.reason.includes('秘密正确理由')));
 }finally{g.finish();}
});

test('非联机猜错到第三次才揭晓全部答案，已结束题目的记录仍可见',async()=>{
 let g;g=new Game({players:[{id:'artist-ai',name:'画手 AI'},{id:'hit-ai',name:'正确 AI'}],human:true,mode:'battle',category:'动物',orderRandom:n=>n-1,revealDelay:0,run:async(_p,_prompt,image)=>image?{guess:g.word.answer,reason:'秘密正确理由'}:{shapes}});
 try{
  await g.next();g.reveal();await g.next();const answer=g.word.answer;
  for(let turn=1;turn<=3;turn++){
   await g.beginGuess({image:renderRelayDrawing(shapes)});g.humanGuess('玩家错误答案');
   if(turn<3){assert(!JSON.stringify(g.snapshot()).includes(answer));await g.revise();}
  }
  assert.equal(g.phase,'reveal');assert.equal(g.snapshot().results['hit-ai'].history[0].guess,answer);
  await g.next();assert(g.snapshot().conversation.some(m=>m.kind==='guess'&&m.text===answer));
 }finally{g.finish();}
});

test('非联机画手和无真人的 AI 观战仍可看已判分回答',async()=>{
 for(const human of [true,false]){
  let g;g=new Game({players:[{id:'artist-ai',name:'AI 一'},{id:'hit-ai',name:'AI 二'},{id:'miss-ai',name:'AI 三'}],human,mode:'battle',category:'动物',orderRandom:n=>n-1,revealDelay:0,run:async p=>({guess:p.id==='hit-ai'?g.word.answer:'错误动物',reason:'图形线索'})});
  try{
   await g.next();await g.beginGuess({shapes,image:renderRelayDrawing(shapes)});assert.equal(g.phase,'review');
   assert.equal(g.snapshot().results['hit-ai'].history[0].guess,g.word.answer);
   assert(g.snapshot().conversation.some(m=>m.kind==='guess'&&m.playerId==='hit-ai'));
  }finally{g.finish();}
 }
});
