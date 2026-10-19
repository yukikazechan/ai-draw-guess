import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomGame} from '../lib/rooms.mjs';
import {renderRelayDrawing} from '../lib/relay-renderer.mjs';

const shapes=[{type:'line',points:[[10,10],[100,100]],color:'#202633',width:5}];
test('multiple humans and AI take turns, score independently, and receive only their own private state',async()=>{
  const g=new RoomGame({players:[{id:'ai',name:'AI',provider:'openrouter',model:'fixture'}],humans:['alice','bob','carol'].map(id=>({id,name:id,human:true})),human:false,mode:'battle',category:'动物',rounds:1,orderRandom:n=>n-1,revealDelay:0,run:async()=>({guess:'错误答案',reason:'测试'}),words:['猫','狗','兔','熊猫'].map(answer=>({answer,category:'动物',aliases:[]}))});
  try{
    await g.next();assert.equal(g.artist.id,'alice');assert.equal(g.snapshot('alice').answer,g.word.answer);assert.equal(g.snapshot('bob').answer,null);assert.equal(g.snapshot('carol').answer,null);
    await g.beginGuess({shapes,image:renderRelayDrawing(shapes)});
    g.humanGuess('bob-secret-guess',false,'bob');
    assert.equal(g.snapshot('carol').results.bob.history.length,0);assert(!JSON.stringify(g.snapshot('carol')).includes('bob-secret-guess'));
    g.humanGuess(g.word.answer,false,'carol');assert.equal(g.phase,'review');assert.equal(g.players.find(p=>p.id==='carol').guessScore,3);assert.equal(g.artist.drawScore,3);
    assert.equal(g.snapshot('bob').answer,null);
    assert.equal(g.snapshot('bob').results.carol.history[0].guess,g.word.answer); // All submissions are public after collective scoring.
    await g.revise();g.privateHints={bob:'only-bob',ai:'only-ai'};
    assert.equal(g.snapshot('bob').myHint,'only-bob');assert.deepEqual(g.snapshot('bob').privateHints,{});assert(!JSON.stringify(g.snapshot('bob')).includes('only-ai'));
    g.reveal();assert.equal(g.snapshot('bob').answer,g.word.answer);await g.next();assert.equal(g.artist.id,'bob');assert.equal(g.snapshot('alice').answer,null);assert.equal(g.snapshot('bob').answer,g.word.answer);
    g.reveal();await g.next();assert.equal(g.artist.id,'carol');g.reveal();await g.next();assert.equal(g.artist.id,'ai');assert.equal(g.phase,'draw-error'); // A fake guess-only model cannot draw; the AI still receives its own turn.
  }finally{g.finish();}
});
