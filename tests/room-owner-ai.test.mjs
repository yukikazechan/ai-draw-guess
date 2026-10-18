import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {OnlineServer} from '../lib/online-server.mjs';
import {RecordingStore} from '../lib/recording.mjs';
import {DEFAULT_PLAYERS} from '../lib/providers.mjs';
import {publicApiFetch} from '../lib/public-api-fetch.mjs';

test('each room uses only its host account AI, and model replies cannot echo its key to players',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'draw-owner-ai-')),calls=[],shapes=[{type:'line',points:[[20,20],[90,90]],color:'#202633',width:5}],recordings=new RecordingStore(join(dir,'recordings'));
  const online=new OnlineServer({directory:dir,port:3211,getConfig:()=>({players:DEFAULT_PLAYERS}),recordings,run:async(p,_prompt,image,_signal,options)=>{calls.push({key:p.apiKey,fetchImpl:options.fetchImpl});return {shapes,guess:'西瓜',reason:p.apiKey,debug:p.apiKey};}});
  try{
    const a=await online.accounts.create({username:'alice',name:'A',password:'alice-password'}),b=await online.accounts.create({username:'bobby',name:'B',password:'bobby-password'});
    for(const [user,key] of [[a,'owner-a-private-key'],[b,'owner-b-private-key']]){
      const cfg=online.profiles.get(user);cfg.openrouterApiKey=key;cfg.players=[cfg.players[0]];cfg.players[0].enabled=true;online.profiles.save(user.id,cfg);online.rooms.create(user);
      await online.rooms.start(user,{playerIds:[cfg.players[0].id],category:'动物',wordLevel:'easy',rounds:1});const room=online.rooms.require(user),g=room.game;
      if(g.phase==='drawing')await online.rooms.action(user,{gameId:g.id,index:g.index,turn:g.turn,action:'draw-done',shapes});
      for(let i=0;i<100&&!calls.some(c=>c.key===key);i++)await new Promise(r=>setTimeout(r,10));
      for(let i=0;i<100&&g.phase==='drawing-ai';i++)await new Promise(r=>setTimeout(r,10));
      assert(calls.some(c=>c.key===key&&c.fetchImpl===publicApiFetch));g.finish();assert(!JSON.stringify(g.snapshot(user.id)).includes(key));
    }
    assert.equal(calls.filter(c=>c.key==='owner-a-private-key').length,1);assert.equal(calls.filter(c=>c.key==='owner-b-private-key').length,1);
    const alice=online.accounts.db.prepare("SELECT * FROM users WHERE username='alice'").get();await assert.rejects(online.userRun(alice,async p=>{throw new Error('upstream echoed '+p.apiKey);})(online.playersFor(alice)[0],'',null),error=>!error.message.includes('owner-a-private-key'));
  }finally{online.close();await recordings.flush();online.accounts.close();assert(dir.startsWith(join(tmpdir(),'draw-owner-ai-')));await rm(dir,{recursive:true,force:true});}
});
