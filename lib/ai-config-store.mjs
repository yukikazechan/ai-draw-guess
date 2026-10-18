import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DEFAULT_PLAYERS,PRESETS,publicPlayer,getKey} from './providers.mjs';
import {OPENROUTER_BASE} from './default-models.mjs';

export function redactSecrets(value,secrets){
  const unique=[...new Set(secrets.filter(Boolean))];const clean=text=>unique.reduce((s,key)=>s.split(key).join('[已隐藏密钥]'),text);
  const walk=value=>{if(typeof value==='string')return clean(value);if(Array.isArray(value))return value.map(walk);if(value&&typeof value==='object'){const result=Object.create(null);for(const [k,v] of Object.entries(value))if(!['__proto__','constructor','prototype'].includes(k))result[clean(k)]=walk(v);return result;}return value;};
  return JSON.parse(JSON.stringify(walk(value)));
}
export class AiConfigStore {
  constructor(accounts,{directory,getLegacyConfig=()=>({players:DEFAULT_PLAYERS}),onLegacyMigrated=()=>{}}){
    this.db=accounts.db;this.getLegacyConfig=getLegacyConfig;this.onLegacyMigrated=onLegacyMigrated;
    this.db.exec('CREATE TABLE IF NOT EXISTS user_ai_configs(user_id TEXT PRIMARY KEY REFERENCES users(id),payload TEXT NOT NULL,updated INTEGER NOT NULL)');
    const keyFile=join(directory,'config-master.key');let encoded=process.env.CONFIG_ENCRYPTION_KEY;
    if(!encoded&&existsSync(keyFile))encoded=readFileSync(keyFile,'utf8').trim();
    if(!encoded){
      if(this.db.prepare('SELECT 1 FROM user_ai_configs LIMIT 1').get())throw new Error('缺少 AI 配置主密钥，已停止启动以避免覆盖旧配置。请恢复 config-master.key 或 CONFIG_ENCRYPTION_KEY。');
      encoded=randomBytes(32).toString('base64');writeFileSync(keyFile,encoded+'\n',{mode:0o600,flag:'wx'});
    }
    this.key=/^[a-f0-9]{64}$/i.test(encoded)?Buffer.from(encoded,'hex'):Buffer.from(encoded,'base64');
    if(this.key.length!==32||!/^[a-zA-Z0-9+/=]+$/.test(encoded))throw new Error('CONFIG_ENCRYPTION_KEY 必须是 32 字节密钥的 Base64 或 64 位十六进制编码。');
  }
  seal(userId,value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);cipher.setAAD(Buffer.from('drawguess-ai-config-v1:'+userId));return JSON.stringify({version:1,iv:iv.toString('base64'),data:Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]).toString('base64'),tag:cipher.getAuthTag().toString('base64')});}
  open(userId,payload){try{const envelope=JSON.parse(payload);if(envelope.version!==1)throw new Error('version');const cipher=createDecipheriv('aes-256-gcm',this.key,Buffer.from(envelope.iv,'base64'));cipher.setAAD(Buffer.from('drawguess-ai-config-v1:'+userId));cipher.setAuthTag(Buffer.from(envelope.tag,'base64'));return JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.data,'base64')),cipher.final()]).toString('utf8'));}catch{throw new Error('AI 配置无法解密，请管理员检查主密钥或恢复备份；旧配置未被覆盖。');}}
  save(userId,value){this.db.prepare('INSERT INTO user_ai_configs VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated').run(userId,this.seal(userId,value),Date.now());}
  template(){const row=this.db.prepare("SELECT value FROM settings WHERE key='ai-template'").get();return row?JSON.parse(row.value):DEFAULT_PLAYERS.map(p=>({...publicPlayer({...p,apiKey:'',credentialScope:'private'}),apiKey:'',credentialScope:'private'}));}
  publish(user){const config=this.get(user),secrets=[config.openrouterApiKey,...config.players.map(p=>p.apiKey)];const players=config.players.filter(p=>p.provider!=='codex').map(p=>({...publicPlayer({...p,apiKey:'',credentialScope:'private'}),apiKey:'',credentialScope:'private'}));if(!players.length)throw new Error('请先配置至少一位 API 选手作为无密钥模板。');this.db.prepare("INSERT INTO settings VALUES('ai-template',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(redactSecrets(players,secrets)));}
  get(user){
    if(user.role==='guest')return {version:4,players:[],openrouterApiKey:''};
    const stored=this.db.prepare('SELECT payload FROM user_ai_configs WHERE user_id=?').get(user.id);if(stored){const config=this.open(user.id,stored.payload);this.finishMigration(user,config);return config;}
    const legacy=user.role==='admin'&&!this.db.prepare("SELECT 1 FROM settings WHERE key='legacy-ai-owner'").get();
    const config={version:4,players:legacy?this.getLegacyConfig().players.map(p=>({...p,apiKey:p.apiKey||((p.baseUrl||PRESETS[p.provider]?.baseUrl)!==OPENROUTER_BASE?getKey(p):'')||'',credentialScope:'private'})):this.template().map(p=>({...p,apiKey:'',credentialScope:'private'})),openrouterApiKey:legacy?getKey({provider:'openrouter',baseUrl:OPENROUTER_BASE})||'':''};
    this.save(user.id,config);
    if(legacy)this.finishMigration(user,config);
    return config;
  }
  finishMigration(user,config){if(user.role==='admin'&&!this.db.prepare("SELECT 1 FROM settings WHERE key='legacy-ai-owner'").get()){this.onLegacyMigrated(redactSecrets({version:4,players:config.players.map(publicPlayer)},[config.openrouterApiKey,...config.players.map(p=>p.apiKey)]));this.db.prepare("INSERT INTO settings VALUES('legacy-ai-owner',?)").run(user.id);}}
  players(user){const config=this.get(user);return config.players.map(p=>({...p,credentialScope:'private',apiKey:p.apiKey||((p.baseUrl||PRESETS[p.provider]?.baseUrl)?.replace(/\/+$/,'')===OPENROUTER_BASE?config.openrouterApiKey:'')||''}));}
}
