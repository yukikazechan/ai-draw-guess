import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Accounts} from '../lib/accounts.mjs';

test('accounts persist sessions, hash passwords, revoke access and enforce ownership and daily budgets',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'draw-accounts-'));let a;
  try{
    a=new Accounts(join(dir,'users.sqlite'),{maxDailyMatches:1,maxDailyCalls:2});
    const admin=await a.create({username:'Admin',name:'管理员',password:'strong-password',role:'admin'});
    const player=await a.create({username:'player',name:'玩家',password:'player-password'});
    assert(!player.password.includes('player-password'));assert.equal(await a.login('unknown','bad-password'),null);assert.equal(await a.login('PLAYER','wrong-password'),null);
    const login=await a.login('PLAYER','player-password'),req={headers:{cookie:'drawguess_auth='+login.token}};
    assert.equal(a.authenticate(req).id,player.id);a.own('match',player.id);assert(a.canRead('match',player));assert(a.canRead('other',admin));assert(!a.canRead('other',player));
    a.charge(player.id,'matches');assert.throws(()=>a.charge(player.id,'matches'),/次数/);a.charge(player.id,'calls');a.charge(player.id,'calls');assert.throws(()=>a.charge(player.id,'calls'),/额度/);
    a.close();a=new Accounts(join(dir,'users.sqlite'));assert.equal(a.authenticate(req).id,player.id);
    await a.update(player.id,{password:'new-player-password'},admin.id);assert.equal(a.authenticate(req),null);assert.equal(await a.login('player','player-password'),null);assert(await a.login('player','new-player-password'));
    await a.update(player.id,{active:false},admin.id);assert.equal(await a.login('player','new-player-password'),null);
    await assert.rejects(a.update(admin.id,{active:false},admin.id),/不能停用/);
  }finally{a?.close();await rm(dir,{recursive:true,force:true});}
});

test('guest registration keeps the same identity and recordings, and unregistered guests expire',async()=>{
  const a=new Accounts(':memory:');try{
    const guest=a.createGuest('临时画家'),login=a.issueSession(guest),req={headers:{cookie:'drawguess_auth='+login.token}};
    a.own('guest-game',guest.id);assert.equal(a.authenticate(req).role,'guest');assert(!a.list().some(u=>u.id===guest.id));
    const registered=await a.registerGuest(guest.id,{username:'newpainter',password:'new-painter-password'});assert.equal(registered.id,guest.id);assert.equal(registered.role,'user');assert(a.canRead('guest-game',registered));assert.equal(a.authenticate(req).role,'user');assert.equal((await a.login('newpainter','new-painter-password')).user.id,guest.id);
    const expired=a.createGuest('过期游客');a.own('expired-game',expired.id);a.issueSession(expired);a.db.prepare('UPDATE users SET expires=? WHERE id=?').run(Date.now()-1,expired.id);
    await assert.rejects(a.registerGuest(expired.id,{username:'toolate',password:'late-password-123'}),/已过期/);a.purgeGuests();assert(!a.get(expired.id));assert(a.get(registered.id));
  }finally{a.close();}
});

test('a site-wide model budget cannot be bypassed with another account',()=>{
  const a=new Accounts(':memory:',{maxDailyTotalCalls:1});try{a.charge('first-account','calls');assert.throws(()=>a.charge('second-account','calls'),/全站/);assert(!a.db.prepare('SELECT 1 FROM usage WHERE user_id=?').get('second-account'));}finally{a.close();}
});
