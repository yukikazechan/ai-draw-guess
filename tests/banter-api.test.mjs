import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import net from 'node:net';
import {startCompatibleFixture} from './fixtures/openai-compatible.mjs';

async function until(fn){const end=Date.now()+15000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,30));}throw new Error('Timed out waiting for the real room API.');}

test('room @AI uses the host compatible API, records both sides, rejects impersonation and supports sender retries',{timeout:45000},async()=>{
  const fixture=await startCompatibleFixture(),directory=await mkdtemp(join(tmpdir(),'draw-banter-api-')),portServer=net.createServer();
  portServer.listen(0,'127.0.0.1');await once(portServer,'listening');const port=portServer.address().port;await new Promise(r=>portServer.close(r));
  const base=`http://127.0.0.1:${port}`,key='fixture-banter-api-key';
  const child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,env:{...process.env,PORT:String(port),PUBLIC_ORIGIN:base,DRAW_GUESS_DATA_DIR:directory,SETUP_TOKEN:'banter-api-setup',OPENROUTER_API_KEY:''},stdio:['ignore','pipe','pipe']});
  let errors='';child.stdout.on('data',()=>{});child.stderr.on('data',b=>errors+=b);
  const request=async(path,data,cookie='',status=200)=>{const response=await fetch(base+path,{headers:{cookie,'Content-Type':'application/json','X-Game-Request':'1',Origin:base},...(data===undefined?{}:{method:'POST',body:JSON.stringify(data)})});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));assert(!JSON.stringify(value).includes(key));return {value,cookie:response.headers.get('set-cookie')?.split(';')[0]};};
  try{
    await until(async()=>{try{return (await fetch(base+'/api/auth/status')).ok;}catch{return false;}});
    const setup=await request('/api/auth/setup',{token:'banter-api-setup',username:'admin',name:'房主',password:'test-admin-password'}),host=setup.cookie;
    const cfg=(await request('/api/config',undefined,host)).value,original=cfg.players.find(p=>p.characterId==='gemini');
    const player={...original,provider:'compatible',baseUrl:fixture.base,model:'fixture-vision',apiKey:key,reasoningEffort:'auto',timeoutSeconds:60,enabled:true};
    await request('/api/config',{players:[player]},host);
    const room=(await request('/api/rooms/create',{},host,201)).value.room;
    const guest=await request('/api/auth/guest',{code:room.id,name:'挑战玩家'},'',201),actor=guest.value.user.id;
    let game=(await request('/api/rooms/start',{playerIds:[player.id],category:'动物',wordLevel:'easy',rounds:1,banter:true},host,202)).value.room.game;
    const stamp={gameId:game.id,index:game.index,turn:game.turn};
    await request('/api/rooms/action',{...stamp,action:'banter-challenge',banterId:'not-revealed',targetId:player.id,text:'不能提前发送'},guest.cookie,400);
    await request('/api/rooms/action',{...stamp,action:'reveal'},host);
    const state=async cookie=>(await request('/api/rooms/state',undefined,cookie)).value.room.game;
    game=await state(host);assert.equal(game.banter.status,'empty');
    const banterId=game.banter.id,message='你这两个圆形画得像水果，解释一下！';
    await request('/api/rooms/action',{...stamp,action:'banter-challenge',banterId,targetId:player.id,fromId:setup.value.user.id,text:message},guest.cookie);
    game=await until(async()=>{const s=await state(host);return s.banter.status==='complete'?s:null;});
    const exchange=game.banter.exchanges.at(-1);assert.equal(exchange.fromId,actor);assert.equal(exchange.toId,player.id);assert.equal(exchange.opener,message);assert(exchange.reply.endsWith('喵。'));
    const sent=fixture.calls.filter(c=>c.purpose==='banter');assert.equal(sent.length,1);assert.equal(sent[0].model,'fixture-vision');assert.equal(sent[0].authorization,'Bearer '+key);assert(sent[0].prompt.includes(message));
    assert(game.conversation.some(m=>m.kind==='banter'&&m.source==='human'&&m.playerId===actor&&m.targetId===player.id));
    assert(game.conversation.some(m=>m.kind==='banter'&&m.source==='model'&&m.playerId===player.id&&m.targetId===actor));
    fixture.setFailBanter(true);
    await request('/api/rooms/action',{...stamp,action:'banter-challenge',banterId,targetId:player.id,text:'这次回应失败也别把消息吞掉。'},guest.cookie);
    game=await until(async()=>{const s=await state(host);return s.banter.status==='error'?s:null;});
    assert.equal(game.banter.exchanges.at(-1).opener,'这次回应失败也别把消息吞掉。');assert.equal(game.banter.exchanges.at(-1).reply,'');
    fixture.setFailBanter(false);
    await request('/api/rooms/action',{...stamp,action:'banter-retry',banterId},guest.cookie);
    game=await until(async()=>{const s=await state(host);return s.banter.status==='complete'?s:null;});assert.equal(game.banter.exchanges.length,2);assert(game.banter.exchanges.at(-1).reply);
    const retried=fixture.calls.filter(c=>c.purpose==='banter').at(-1);assert(retried.prompt.includes(message));assert(retried.prompt.includes(exchange.reply));
    const done=new Set(game.conversation.filter(m=>m.kind==='banter').map(m=>m.id));assert.equal(done.size,4);
    const beforeHumanMessages=fixture.calls.length;
    await request('/api/rooms/action',{...stamp,action:'banter-challenge',banterId,targetId:actor,text:'@真人，这幅画你有什么想说的？'},host);
    game=await until(async()=>{const s=await state(guest.cookie);return s.banter.status==='waiting-human'?s:null;});
    const humanExchange=game.banter.exchanges.at(-1);assert.equal(humanExchange.toId,actor);
    await request('/api/rooms/action',{...stamp,action:'banter-reply',banterId,exchangeId:humanExchange.id,text:'冒名代答'},host,400);
    await request('/api/rooms/action',{...stamp,action:'banter-reply',banterId,exchangeId:humanExchange.id,text:'我本人觉得这两颗果子挺明显的。'},guest.cookie);
    game=await until(async()=>{const s=await state(host);return s.banter.status==='complete'?s:null;});
    assert.equal(fixture.calls.length,beforeHumanMessages);assert.equal(game.banter.exchanges.at(-1).reply,'我本人觉得这两颗果子挺明显的。');
    assert.equal(game.conversation.filter(m=>m.kind==='banter'&&m.source==='human').length,4);
    await request('/api/rooms/action',{...stamp,action:'banter-challenge',banterId,targetId:player.id,text:'第三次，接着刚才的解释说。'},guest.cookie);
    game=await until(async()=>{const s=await state(host);return s.banter.status==='complete'?s:null;});
    const continued=fixture.calls.filter(c=>c.purpose==='banter').at(-1).prompt;
    for(const text of [message,exchange.reply,'这次回应失败也别把消息吞掉。','我本人觉得这两颗果子挺明显的。','第三次，接着刚才的解释说。'])assert(continued.includes(text));
    const observer=await request('/api/auth/guest',{code:room.id,name:'互怼观众'},'',201),originalSize=game.players.length;
    assert.equal(observer.value.room.game.viewerRole,'spectator');
    await request('/api/rooms/action',{...stamp,action:'banter-challenge',banterId,targetId:player.id,fromId:setup.value.user.id,text:'观众也来聊两句，接着刚才说。'},observer.cookie);
    game=await until(async()=>{const s=await state(observer.cookie);return s.banter.status==='complete'?s:null;});
    assert.equal(game.players.length,originalSize);assert(!game.players.some(p=>p.id===observer.value.user.id));
    assert.equal(game.banter.exchanges.at(-1).fromId,observer.value.user.id);assert.equal(game.conversation.find(m=>m.playerId===observer.value.user.id).name,'互怼观众');
    await request('/api/rooms/action',{...stamp,action:'finish'},observer.cookie,400);
    await request('/api/rooms/leave',{},observer.cookie);assert.equal((await state(host)).phase,'reveal');
    await request('/api/rooms/action',{...stamp,action:'finish'},host);
    const third=await request('/api/auth/guest',{code:room.id,name:'另一玩家'},'',201);
    await request('/api/admin/defaults',{category:'动物',wordLevel:'easy',rounds:1,hintMode:'none',playerIds:[player.id],useCustomWords:true,customWords:['秘密甲','秘密乙','秘密丙','秘密丁']},host);
    game=(await request('/api/rooms/start',{playerIds:[player.id],category:'动物',wordLevel:'easy',rounds:1,useCustomWords:true,banter:false},host,202)).value.room.game;
    while(!game.artistHuman){const current={gameId:game.id,index:game.index,turn:game.turn};await request('/api/rooms/action',{...current,action:'reveal'},host);await request('/api/rooms/action',{...current,action:'next'},host);game=await state(host);}
    const cookies=new Map([[setup.value.user.id,host],[actor,guest.cookie],[third.value.user.id,third.cookie]]),artistCookie=cookies.get(game.artistId),humanGuessers=game.players.filter(p=>p.human&&p.id!==game.artistId);
    const answer=(await state(artistCookie)).answer;fixture.setGuess(answer);
    const current={gameId:game.id,index:game.index,turn:game.turn};
    await request('/api/rooms/action',{...current,action:'draw-done',shapes:[{type:'rect',x:100,y:100,w:120,h:90,color:'#202633',width:5}]},artistCookie);
    await request('/api/rooms/action',{...current,action:'guess',guess:'错误词'},cookies.get(humanGuessers[0].id));
    await request('/api/rooms/action',{...current,action:'guess',guess:answer},cookies.get(humanGuessers[1].id));
    game=await until(async()=>{const s=await state(host);return s.phase==='review'?s:null;});
    const blind=await state(cookies.get(humanGuessers[0].id)),solved=await state(cookies.get(humanGuessers[1].id));
    assert.equal(blind.answer,null);assert(!JSON.stringify(blind).includes(answer));assert.deepEqual(blind.results[player.id].history,[]);
    assert.equal(solved.answer,answer);assert.equal(solved.results[player.id].history[0].guess,answer);assert.equal(solved.results[humanGuessers[0].id].history[0].guess,'错误词');
  }catch(e){e.message+='\n'+errors;throw e;}
  finally{if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}await fixture.close();await rm(directory,{recursive:true,force:true});}
});
