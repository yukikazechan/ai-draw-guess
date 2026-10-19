import test from 'node:test';
import assert from 'node:assert/strict';
import {createCanvas} from '@napi-rs/canvas';
import {paint,floodFill,DrawingHistory,W,H} from '../public/drawing.mjs';
import {validateShapes} from '../lib/shapes.mjs';
import {renderRelayDrawing,drawingHasInk} from '../lib/relay-renderer.mjs';
import {drawingSVG} from '../lib/production-export.mjs';
import {tablePlaces} from '../public/seat-presentation.mjs';
import {RoomGame,Rooms} from '../lib/rooms.mjs';
import {createRoomClient} from '../public/room-client.mjs';
import {roundAnswerMarkup} from '../public/round-results.mjs';
import {createMobileRoster} from '../public/mobile-roster.mjs';

const outline={type:'rect',x:100,y:100,w:200,h:200,color:'#202633',width:6};
const bucket={type:'bucket',x:200,y:200,color:'#ff0000'};
const pixel=(canvas,x,y)=>[...canvas.getContext('2d').getImageData(x,y,1,1).data];

test('bucket fills a closed region, preserves outlines, replays on the server, and undoes in one operation',()=>{
  const shapes=validateShapes([outline,bucket]),canvas=createCanvas(W,H);paint(canvas,shapes);
  assert.deepEqual(pixel(canvas,200,200),[255,0,0,255]);
  assert.deepEqual(pixel(canvas,50,50),[255,255,255,255]);
  assert.deepEqual(pixel(canvas,100,200),[32,38,51,255]);
  assert.match(renderRelayDrawing(shapes),/^data:image\/png;base64,/);
  assert.match(drawingSVG(shapes),/<image .*data:image\/png;base64,/);
  const history=new DrawingHistory();history.stroke(1);paint(canvas,history.undo(shapes));
  assert.deepEqual(pixel(canvas,200,200),[255,255,255,255]);
  assert.throws(()=>validateShapes([{...bucket,x:1000}]));
  assert.throws(()=>validateShapes([{...bucket,color:'url(https://example.test)'}]));
});

test('bucket coordinates follow the canvas scale and connected fill handles edges and equal colors',()=>{
  const canvas=createCanvas(500,325);paint(canvas,[outline,bucket]);
  assert.deepEqual(pixel(canvas,100,100),[255,0,0,255]);
  assert.deepEqual(pixel(canvas,25,25),[255,255,255,255]);
  const data=new Uint8ClampedArray(4*4*4).fill(255);
  assert.equal(floodFill(data,4,4,0,0,'#ffffff'),0);
  assert.equal(floodFill(data,4,4,0,0,'#000000'),16);
  assert.equal(floodFill(data,4,4,-1,0,'#ff0000'),0);
  assert.equal(drawingHasInk([]),false);assert.equal(drawingHasInk([{type:'bucket',x:0,y:0,color:'#ffffff'}]),false);assert.equal(drawingHasInk([outline]),true);
});

test('blank redraw timeout resets only this artist question and tops opponents up to three without double awards',async()=>{
  const g=new RoomGame({players:[],humans:['a','b','c'].map(id=>({id,name:id,human:true})),human:false,mode:'battle',category:'动物',orderRandom:n=>n-1});
  try{
    await g.next();g.turn=2;g.artist.drawScore=7;g.roundGain=2;
    g.players.find(p=>p.id==='b').guessScore=10;g.results.b.points=2;g.results.b.solved=true;
    g.forfeitDrawing();
    assert.equal(g.artist.drawScore,5);assert.equal(g.roundGain,0);assert.equal(g.players.find(p=>p.id==='b').guessScore,11);assert.equal(g.players.find(p=>p.id==='c').guessScore,3);
    assert.equal(g.results.b.points,3);assert.equal(g.results.c.points,3);assert(g.snapshot('b').results.b.forfeit);
    const html=roundAnswerMarkup(g.snapshot('c').results.c.history);assert(html.includes('画手空白超时'));assert(html.includes('+3'));
  }finally{g.finish();}
});

test('all eight humans and five AI have distinct places with the viewer reserved at south',()=>{
  const players=[...Array.from({length:8},(_,i)=>({id:'human-'+i,human:true})),...Array.from({length:5},(_,i)=>({id:'ai-'+i}))];
  for(const viewer of players.filter(p=>p.human)){
    const places=tablePlaces(players,viewer.id);
    assert.equal(places.size,13);assert.equal(new Set(places.values()).size,13);
    assert.equal(places.get(viewer.id),'south');assert(![...places.values()].includes(undefined));
  }
});

test('each collective guess round becomes public, while the next round remains private until scoring',async()=>{
  const g=new RoomGame({players:[],humans:['a','b','c'].map(id=>({id,name:id,human:true})),human:false,mode:'battle',category:'动物',words:['猫','狗','兔'].map(answer=>({answer,category:'动物',aliases:[]})),orderRandom:n=>n-1,revealDelay:60000});
  try{
    await g.next();await g.beginGuess({shapes:[outline],image:renderRelayDrawing([outline])});
    g.humanGuess('第一轮乙',false,'b');
    assert(!JSON.stringify(g.snapshot('c')).includes('第一轮乙'));
    g.humanGuess('第一轮丙',false,'c');assert.equal(g.phase,'locked');
    assert(!JSON.stringify(g.snapshot('b')).includes('第一轮丙'));
    g.publishGuesses();assert.equal(g.phase,'review');
    assert.equal(g.snapshot('b').results.c.history[0].guess,'第一轮丙');
    assert(g.snapshot('c').conversation.some(m=>m.text==='第一轮乙'));
    await g.revise();await g.beginGuess({shapes:[outline,bucket],image:renderRelayDrawing([outline,bucket])});
    g.humanGuess('第二轮乙',false,'b');
    const privateState=g.snapshot('c');assert(privateState.results.b.history.some(h=>h.guess==='第一轮乙'));
    assert(!JSON.stringify(privateState).includes('第二轮乙'));
    const html=roundAnswerMarkup([{turn:1,guess:'<img src=x>',correct:false},{turn:2,guess:'猫',correct:true,points:2}],s=>s.replaceAll('<','&lt;'));
    assert(!html.includes('<img'));assert(html.includes('✓ +2'));assert(html.includes('第 1 轮'));
  }finally{g.finish();}
});

test('room adapter rejects older states and routes actions with the current round stamp',async()=>{
  const calls=[],changes=[],connections=[],sockets=[];
  class Socket{constructor(){this.readyState=1;sockets.push(this);}close(){}send(value){this.sent=value;}}
  const state={id:'ROOM',version:4,game:{id:'match',phase:'drawing',index:2,turn:1}};
  const client=createRoomClient({Socket,url:{protocol:'https:',host:'example.test'},request:async(path,data)=>{calls.push({path,data});return path==='/api/rooms/state'?{room:structuredClone(state)}:{ok:true};},onChange:r=>changes.push(r),onConnection:value=>connections.push(value)});
  try{
    await client.enter();const ws=sockets.at(-1);ws.onopen();
    ws.onmessage({data:JSON.stringify({type:'state',room:{...state,version:3}})});assert.equal(client.room.version,4);
    client.drawing([outline,bucket]);await new Promise(r=>setTimeout(r,100));
    assert.equal(JSON.parse(ws.sent).shapes[1].type,'bucket');
    await client.action('draw-done',{shapes:[outline,bucket]});
    assert.deepEqual(calls.find(c=>c.path==='/api/rooms/action').data,{gameId:'match',index:2,turn:1,action:'draw-done',shapes:[outline,bucket]});
    client.suspend();assert.equal(connections.at(-1),false);
  }finally{client.suspend();}
});

test('only the named human can reply to room banter, and only the host can reset a finished game',async()=>{
  const rooms=new Rooms({accounts:{},recordings:{},makeOptions:()=>({})}),a={id:'a',name:'A'},b={id:'b',name:'B'};
  rooms.create(a);const room=rooms.require(a);rooms.join(b,room.id);
  let replies=0;room.game={id:'g',index:0,turn:1,phase:'reveal',players:[{...a,human:true},{...b,human:true}],artist:{id:'a'},banter:{index:0,exchanges:[{toId:'b'}],check(){},reply(){replies++;}},snapshot(){return {};}};
  const stamp={gameId:'g',index:0,turn:1};
  await assert.rejects(rooms.action(a,{...stamp,action:'banter-reply'}),/轮到自己/);
  await rooms.action(b,{...stamp,action:'banter-reply'});assert.equal(replies,1);
  await assert.rejects(rooms.action(b,{...stamp,action:'home'}),/房主/);
  room.game.phase='finished';await rooms.action(a,{...stamp,action:'home'});assert.equal(room.game,null);
});

test('mobile seats support gesture snapping without page buttons and survive desktop reparenting',t=>{
  const original=Object.fromEntries(['matchMedia','document','requestAnimationFrame','cancelAnimationFrame','addEventListener'].map(k=>[k,globalThis[k]]));
  t.after(()=>{for(const [key,value] of Object.entries(original))if(value===undefined)delete globalThis[key];else globalThis[key]=value;});
  let mediaChanged,rafId=0;const frames=new Map(),media={matches:true,addEventListener(_name,fn){mediaChanged=fn;}};
  const events={},pages={children:[],replaceChildren(){this.children=[];},append(node){this.children.push(node);}},count={textContent:''},track={append(node){node.parentElement=this;}},home={querySelector(){return null;},insertBefore(node){node.parentElement=this;}};
  const container={parentElement:home,clientWidth:340,scrollLeft:0,style:{},setAttribute(){},setPointerCapture(){},addEventListener(name,fn){events[name]=fn;},scrollTo({left}){this.scrollLeft=Math.max(0,left);events.scroll?.();}};
  const section={dataset:{},querySelector(selector){return {'[data-roster-pages]':pages,'[data-roster-count]':count,'[data-roster-track]':track}[selector];}};
  globalThis.matchMedia=query=>query.includes('reduced-motion')?{matches:true}:media;
  globalThis.document={createElement:tag=>({tag,dataset:{}})};
  globalThis.requestAnimationFrame=fn=>{frames.set(++rafId,fn);return rafId;};globalThis.cancelAnimationFrame=id=>frames.delete(id);globalThis.addEventListener=()=>{};
  const flush=()=>{for(const [id,fn] of [...frames]){frames.delete(id);fn();}};
  const roster=createMobileRoster({container,section,home}),game={id:'match',index:0,phase:'guessing',artistId:'p0',players:Array.from({length:5},(_,i)=>({id:'p'+i}))};
  roster.update(game);flush();assert.equal(container.parentElement,track);assert.equal(pages.children.length,3);assert(pages.children.every(n=>n.tag==='span'));
  const pointer=(x)=>({pointerId:1,pointerType:'mouse',button:0,clientX:x,target:{closest(){return null;}},preventDefault(){}});
  events.pointerdown(pointer(300));events.pointermove(pointer(50));flush();events.pointerup(pointer(50));flush();
  assert.equal(container.scrollLeft,348);assert.equal(count.textContent,'2 / 3');assert.equal(container.style.scrollSnapType,'');
  roster.update({...game,updated:2});flush();assert.equal(container.scrollLeft,348);
  events.keydown({target:container,key:'ArrowRight',preventDefault(){}});flush();assert.equal(count.textContent,'3 / 3');
  media.matches=false;mediaChanged();assert.equal(container.parentElement,home);assert.equal(section.hidden,true);
});

test('server drawing deadline stays fixed while strokes arrive and submits the existing image on expiry',async()=>{
  const users=['a','b'].map(id=>({id,name:id}));
  const rooms=new Rooms({accounts:{charge(){},own(){}},recordings:{attach(){}},makeOptions:()=>({players:[],category:'动物',rounds:1,orderRandom:n=>n-1})});
  try{
    rooms.create(users[0]);const room=rooms.require(users[0]);rooms.join(users[1],room.id);
    await rooms.start(users[0],{drawSeconds:60,guessSeconds:20});const g=room.game,deadline=g.clock.deadline;
    rooms.drawing(users[0],{gameId:g.id,index:g.index,turn:g.turn,shapes:[outline,bucket]});
    assert.equal(g.clock.deadline,deadline);assert.equal(g.snapshot('b').clock.duration,60);
    g.clock.deadline=Date.now()-1;rooms.expire(room);await new Promise(r=>setImmediate(r));
    assert.equal(g.phase,'guessing');assert.equal(g.clock.stage,'guess');assert.equal(g.clock.duration,20);assert.equal(g.shapes[1].type,'bucket');
    g.reveal();await g.next();assert.equal(g.artist.id,'b');g.clock.deadline=Date.now()-1;rooms.expire(room);
    assert.equal(g.phase,'reveal');assert.match(g.notice,/画手 0 分/);assert.equal(g.clock,null);assert.equal(g.artist.drawScore,0);assert.equal(g.players.find(p=>p.id==='a').guessScore,3);
  }finally{rooms.close();}
});

test('player guess deadline gives missing humans zero while AI keeps its own request timeout',async()=>{
  const users=['a','b','c'].map(id=>({id,name:id}));let reply;
  const rooms=new Rooms({accounts:{charge(){},own(){}},recordings:{attach(){}},makeOptions:()=>({players:[{id:'ai',name:'AI',provider:'compatible'}],category:'动物',rounds:1,orderRandom:n=>n-1,run:()=>new Promise(resolve=>{reply=resolve;})})});
  try{
    rooms.create(users[0]);const room=rooms.require(users[0]);for(const u of users.slice(1))rooms.join(u,room.id);
    await rooms.start(users[0],{drawSeconds:90,guessSeconds:30});const g=room.game;
    const pending=rooms.action(users[0],{gameId:g.id,index:g.index,turn:g.turn,action:'draw-done',shapes:[outline]});
    g.humanGuess('乙的答案',false,'b');g.clock.deadline=Date.now()-1;rooms.expire(room);
    assert.equal(g.phase,'guessing');assert(g.results.c.pending.skipped);assert(g.results.c.pending.timedOut);assert.equal(g.results.ai.pending,undefined);assert.equal(g.results.ai.status,'thinking');assert.equal(g.controller.signal.aborted,false);assert.equal(g.results.b.pending.guess,'乙的答案');assert.equal(g.clock,null);
    reply({guess:g.word.answer,confidence:100});await pending;g.publishGuesses();
    assert.equal(g.results.ai.history.length,1);assert(!g.results.ai.history[0].skipped);assert.equal(g.players.find(p=>p.id==='ai').guessScore,3);
    const snapshot=g.snapshot('c');assert.equal(snapshot.results.b.history[0].guess,'乙的答案');assert.equal(g.clock,null);
  }finally{rooms.close();}
});

test('房间 AI 画好后自动开始猜题，未全猜中自动补画，不依赖房主浏览器',async()=>{
 let draws=0;const users=['a','b'].map(id=>({id,name:id}));
 const rooms=new Rooms({accounts:{charge(){},own(){}},recordings:{attach(){}},makeOptions:()=>({players:[{id:'ai',name:'AI',provider:'compatible'}],category:'动物',rounds:1,orderRandom:n=>n===3?0:n-1,run:async()=>{draws++;return {shapes:[outline]};}})});
 try{
  rooms.create(users[0]);const room=rooms.require(users[0]);rooms.join(users[1],room.id);await rooms.start(users[0],{});await new Promise(r=>setImmediate(r));const g=room.game;g.revealDelay=0;
  assert.equal(g.artist.id,'ai');assert.equal(g.phase,'ready');assert.equal(g.clock.stage,'ready');
  clearTimeout(room.clockTimer);g.clock.deadline=Date.now()-1;rooms.expire(room);await new Promise(r=>setImmediate(r));assert.equal(g.phase,'guessing');
  g.humanGuess('第一个错词',false,'a');g.humanGuess('第二个错词',false,'b');assert.equal(g.phase,'review');assert.equal(g.clock.stage,'revise');assert.equal(g.clock.duration,3);
  clearTimeout(room.clockTimer);g.clock.deadline=Date.now()-1;rooms.expire(room);await new Promise(r=>setImmediate(r));
  assert.equal(g.turn,2);assert.equal(g.phase,'ready');assert.equal(draws,2);
  clearTimeout(room.clockTimer);g.clock.deadline=Date.now()-1;rooms.expire(room);await new Promise(r=>setImmediate(r));assert.equal(g.phase,'guessing');assert.equal(g.turn,2);
 }finally{rooms.close();}
});
