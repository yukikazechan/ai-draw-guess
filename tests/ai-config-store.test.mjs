import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Accounts} from '../lib/accounts.mjs';
import {AiConfigStore} from '../lib/ai-config-store.mjs';
import {getKey,DEFAULT_PLAYERS} from '../lib/providers.mjs';
import {setSharedOpenRouterKey} from '../lib/credentials.mjs';

test('AI settings are account-scoped, encrypted, persistent and templates never inherit keys',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'draw-ai-config-')),oldMaster=process.env.CONFIG_ENCRYPTION_KEY,oldRouter=process.env.OPENROUTER_API_KEY;let a;
  try{
    delete process.env.CONFIG_ENCRYPTION_KEY;process.env.OPENROUTER_API_KEY='legacy-environment-key';setSharedOpenRouterKey('');
    a=new Accounts(join(dir,'accounts.sqlite'));const admin=await a.create({username:'admin',name:'管理员',password:'admin-password',role:'admin'}),alice=await a.create({username:'alice',name:'玩家',password:'alice-password'});
    const store=new AiConfigStore(a,{directory:dir,getLegacyConfig:()=>({players:DEFAULT_PLAYERS})});
    assert.equal(store.players(admin)[0].apiKey,'legacy-environment-key');const own=store.get(alice);assert.equal(own.openrouterApiKey,'');assert(own.players.every(p=>!getKey(p)));
    own.openrouterApiKey='alice-private-key';store.save(alice.id,own);assert.equal(store.players(alice)[0].apiKey,'alice-private-key');assert.equal(store.players(admin)[0].apiKey,'legacy-environment-key');
    const first=a.db.prepare('SELECT payload FROM user_ai_configs WHERE user_id=?').get(alice.id).payload;store.save(alice.id,own);const second=a.db.prepare('SELECT payload FROM user_ai_configs WHERE user_id=?').get(alice.id).payload;assert.notEqual(first,second);assert(!second.includes('alice-private-key'));
    const restored=new AiConfigStore(a,{directory:dir});assert.equal(restored.get(alice).openrouterApiKey,'alice-private-key');
    a.db.prepare('UPDATE user_ai_configs SET payload=? WHERE user_id=?').run(second,admin.id);assert.throws(()=>restored.get(admin),/无法解密/);store.save(admin.id,{...own,openrouterApiKey:'admin-private-key'});
    store.publish(admin);const template=a.db.prepare("SELECT value FROM settings WHERE key='ai-template'").get().value;assert(!template.includes('admin-private-key'));assert(!template.includes('alice-private-key'));
    const bob=await a.create({username:'bob',name:'新用户',password:'bob-password-123'});assert(store.players(bob).every(p=>!getKey(p)));
    const keyPath=join(dir,'config-master.key'),savedKey=await readFile(keyPath);await unlink(keyPath);assert.throws(()=>new AiConfigStore(a,{directory:dir}),/缺少.*主密钥/);await writeFile(keyPath,savedKey,{mode:0o600});
    process.env.CONFIG_ENCRYPTION_KEY='ab'.repeat(32);assert.throws(()=>new AiConfigStore(a,{directory:dir}).get(alice),/无法解密/);
  }finally{a?.close();if(oldMaster===undefined)delete process.env.CONFIG_ENCRYPTION_KEY;else process.env.CONFIG_ENCRYPTION_KEY=oldMaster;if(oldRouter===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=oldRouter;setSharedOpenRouterKey('');assert(dir.startsWith(join(tmpdir(),'draw-ai-config-')));await rm(dir,{recursive:true,force:true});}
});
