import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import net from 'node:net';
const until=async(fn)=>{const stop=Date.now()+15000;while(Date.now()<stop){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,35));}throw new Error('Local API timeout');};
test('HTTP 联机玩法可切换；卧底私词和匿名票隔离，接龙多人完整交卷并公开结算',{timeout:40000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'draw-new-modes-')),reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const base=`http://127.0.0.1:${port}`,child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),windowsHide:true,env:{...process.env,PORT:String(port),PUBLIC_ORIGIN:base,DRAW_GUESS_DATA_DIR:directory,SETUP_TOKEN:'local-modes-setup',OPENROUTER_API_KEY:''},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',()=>{});child.stderr.on('data',b=>log+=b);
  const request=async(path,data,cookie='',status=200)=>{const res=await fetch(base+path,{headers:{cookie,'Content-Type':'application/json','X-Game-Request':'1',Origin:base},...(data===undefined?{}:{method:'POST',body:JSON.stringify(data)})});const value=await res.json();assert.equal(res.status,status,JSON.stringify(value));return {value,cookie:res.headers.get('set-cookie')?.split(';')[0]};};
  try{
    await until(async()=>{try{return (await fetch(base+'/api/auth/status')).ok;}catch{return false;}});
    const host=await request('/api/auth/setup',{token:'local-modes-setup',username:'modehost',name:'房主',password:'local-only-password'}),room=(await request('/api/rooms/create',{},host.cookie,201)).value.room;
    const guests=[];for(let i=0;i<3;i++)guests.push(await request('/api/auth/guest',{code:room.id,name:'玩家'+i},'',201));
    const accounts=[host,...guests],cookies=new Map(accounts.map(a=>[a.value.user.id,a.cookie])),state=async cookie=>(await request('/api/rooms/state',undefined,cookie)).value.room;
    await request('/api/rooms/lobby',{roomId:room.id,playerIds:[],mode:'undercover'},guests[0].cookie,400);
    await request('/api/rooms/lobby',{roomId:room.id,playerIds:[],mode:'undercover'},host.cookie);assert.equal((await state(guests[0].cookie)).mode,'undercover');
    let game=(await request('/api/rooms/start',{mode:'undercover',playerIds:[],category:'动物',wordLevel:'easy',rounds:1},host.cookie,202)).value.room.game;
    const states=await Promise.all(accounts.map(a=>state(a.cookie))),words=states.map(s=>s.game.undercover.myWord);assert.equal(new Set(words).size,2);
    for(const s of states){assert.equal(s.game.undercover.assignments,null);assert(!s.game.players.some(p=>p.role));const other=words.find(w=>w!==s.game.undercover.myWord);assert(!JSON.stringify(s.game).includes(other));}
    const watcher=await request('/api/auth/guest',{code:room.id,name:'观众'},'',201);assert.equal(watcher.value.room.game.undercover.myWord,null);
    await request('/api/rooms/chat',{roomId:room.id,text:'不能剧透'},watcher.cookie,400);
    for(let i=0;i<4;i++){
      game=(await state(host.cookie)).game;const speaker=game.undercover.speakerId,stamp={gameId:game.id,index:game.index,turn:game.turn};
      await request('/api/rooms/action',{...stamp,action:'undercover-describe',text:'这是常见的生活物品',playerId:speaker},watcher.cookie,400);
      await request('/api/rooms/action',{...stamp,action:'undercover-describe',text:'这是常见的生活物品'},cookies.get(speaker));
    }
    game=(await state(host.cookie)).game;assert.equal(game.phase,'undercover-vote');const ids=[...cookies.keys()],stamp={gameId:game.id,index:game.index,turn:game.turn};
    await request('/api/rooms/action',{...stamp,action:'undercover-vote',targetId:ids[1]},host.cookie);
    assert.equal((await state(guests[0].cookie)).game.undercover.myVote,null);assert.equal((await state(guests[0].cookie)).game.history.length,0);
    await request('/api/rooms/action',{...stamp,action:'finish'},host.cookie);await request('/api/rooms/leave',{},watcher.cookie);
    game=(await state(host.cookie)).game;assert.equal(Object.keys(game.undercover.assignments).length,4);
    await request('/api/rooms/action',{gameId:game.id,index:game.index,turn:game.turn,action:'home'},host.cookie);
    await request('/api/rooms/lobby',{roomId:room.id,playerIds:[],mode:'relay'},host.cookie);
    game=(await request('/api/rooms/start',{mode:'relay',playerIds:[],category:'动物',wordLevel:'easy',rounds:1},host.cookie,202)).value.room.game;
    for(let stage=0;stage<4;stage++){
      for(const a of accounts){const g=(await state(a.cookie)).game,task=g.relay.myTask;assert.equal(g.index,stage);assert.deepEqual(g.chains,[]);await request('/api/rooms/action',{gameId:g.id,index:stage,action:'relay-submit',stage,chainId:task.chainId,shapes:[{type:'rect',x:100,y:100,w:200,h:120,color:'#202633',width:5}],guess:'自己的接龙词'},a.cookie);}
      await until(async()=>{const g=(await state(host.cookie)).game;return stage===3?g.phase==='finished':g.index===stage+1;});
    }
    game=(await state(host.cookie)).game;assert.equal(game.chains.length,4);assert(game.chains.every(c=>c.steps.length===4));assert.equal(game.relay.completed,true);
    const html=await (await fetch(base+'/',{headers:{cookie:host.cookie}})).text();assert(html.includes('id="roomGameMode"'));assert(html.includes('id="undercoverStage"'));
    const config=(await request('/api/config',undefined,host.cookie)).value;for(const file of ['undercover-view.mjs','undercover.css'])assert((await fetch(`${base}/_app/${config.clientVersion}/${file}`)).ok);
  }catch(error){error.message+='\n'+log;throw error;}finally{if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}await rm(directory,{recursive:true,force:true});}
});
