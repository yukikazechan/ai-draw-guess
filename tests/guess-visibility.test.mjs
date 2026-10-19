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

test('单人对战和人机比赛仍可展示其他 AI 已判分的正确回答',async()=>{
 let g;g=new Game({players:[{id:'artist-ai',name:'画手 AI',provider:'compatible'},{id:'hit-ai',name:'正确 AI',provider:'compatible'}],human:true,mode:'battle',category:'动物',orderRandom:n=>n-1,revealDelay:0,run:async(_p,_prompt,image)=>image?{guess:g.word.answer,reason:'真实图形线索'}:{shapes}});
 try{
  await g.next();g.reveal();await g.next();assert.equal(g.artist.id,'artist-ai');
  await g.beginGuess({image:renderRelayDrawing(shapes)});g.humanGuess('错误动物');assert.equal(g.phase,'review');
  assert.equal(g.snapshot().results['hit-ai'].history[0].guess,g.word.answer);
  assert(g.snapshot().conversation.some(m=>m.kind==='guess'&&m.playerId==='hit-ai'));
 }finally{g.finish();}
});
