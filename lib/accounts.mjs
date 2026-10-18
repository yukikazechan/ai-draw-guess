import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,scrypt as scryptCallback,timingSafeEqual,createHash} from 'node:crypto';
import {promisify} from 'node:util';

const scrypt=promisify(scryptCallback);
const digest=value=>createHash('sha256').update(value).digest('hex');
export const publicUser=u=>u?{id:u.id,username:u.username,name:u.name,role:u.role,active:!!u.active}:null;
export class Accounts {
  constructor(path,{sessionDays=7,maxDailyMatches=20,maxDailyCalls=300,maxDailyTotalCalls=1000}={}){
    this.db=new DatabaseSync(path);this.sessionDays=sessionDays;this.maxDailyMatches=maxDailyMatches;this.maxDailyCalls=maxDailyCalls;this.maxDailyTotalCalls=maxDailyTotalCalls;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ownership(game_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),PRIMARY KEY(game_id,user_id));
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS user_ai_configs(user_id TEXT PRIMARY KEY REFERENCES users(id),payload TEXT NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage(user_id TEXT NOT NULL,day TEXT NOT NULL,matches INTEGER DEFAULT 0,calls INTEGER DEFAULT 0,PRIMARY KEY(user_id,day));`);
    if(!this.db.prepare('PRAGMA table_info(users)').all().some(c=>c.name==='expires'))this.db.exec('ALTER TABLE users ADD COLUMN expires INTEGER');
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }
  hasAdmin(){return !!this.db.prepare("SELECT 1 FROM users WHERE role='admin' AND active=1").get();}
  async password(value){
    if(typeof value!=='string'||value.length<10||value.length>128)throw new Error('密码须为 10–128 个字符。');
    const salt=randomBytes(16).toString('hex'),key=await scrypt(value,salt,64);
    return salt+':'+key.toString('hex');
  }
  async create({username,name,password,role='user'}){
    if(typeof username!=='string'||!/^[a-zA-Z0-9_-]{3,32}$/.test(username))throw new Error('账号须为 3–32 位字母、数字、下划线或短横线。');
    if(typeof name!=='string'||!name.trim()||name.trim().length>40)throw new Error('昵称须为 1–40 字。');
    if(!['user','admin'].includes(role))throw new Error('账号角色无效。');
    if(this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n>=1000)throw new Error('账号数量已达上限。');
    const hash=await this.password(password),id=randomUUID();
    try{this.db.prepare('INSERT INTO users(id,username,name,password,role) VALUES(?,?,?,?,?)').run(id,username.toLowerCase(),name.trim(),hash,role);}catch(e){if(e.code?.includes('CONSTRAINT')||e.message.includes('UNIQUE'))throw new Error('该账号已存在。');throw e;}
    return this.get(id);
  }
  get(id){return this.db.prepare('SELECT * FROM users WHERE id=?').get(id);}
  list(){return this.db.prepare("SELECT * FROM users WHERE role!='guest' ORDER BY role,username").all().map(publicUser);}
  issueSession(user){const token=randomBytes(32).toString('hex');this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token),user.id,Math.min(user.expires||Infinity,Date.now()+this.sessionDays*86400000));return {token,user:publicUser(user)};}
  createGuest(name){
    if(typeof name!=='string'||!name.trim()||name.trim().length>40)throw new Error('游客昵称须为 1–40 字。');
    if(this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n>=1000)throw new Error('在线账号数量已达上限，请稍后再试。');
    const id=randomUUID(),username='guest_'+randomBytes(12).toString('hex');
    this.db.prepare("INSERT INTO users(id,username,name,password,role,expires) VALUES(?,?,?,?,'guest',?)").run(id,username,name.trim(),'00'.repeat(16)+':'+'00'.repeat(64),Date.now()+86400000);
    return this.get(id);
  }
  async registerGuest(id,{username,password}){
    if(typeof username!=='string'||!/^[a-zA-Z0-9_-]{3,32}$/.test(username))throw new Error('账号须为 3–32 位字母、数字、下划线或短横线。');
    const hash=await this.password(password);
    try{const result=this.db.prepare("UPDATE users SET username=?,password=?,role='user',expires=NULL WHERE id=? AND role='guest' AND active=1 AND expires>?").run(username.toLowerCase(),hash,id,Date.now());if(!result.changes)throw new Error('游客身份已过期，请重新加入房间。');}
    catch(e){if(e.code?.includes('CONSTRAINT')||e.message.includes('UNIQUE'))throw new Error('该账号已存在。');throw e;}
    this.db.prepare('UPDATE sessions SET expires=? WHERE user_id=?').run(Date.now()+this.sessionDays*86400000,id);
    return publicUser(this.get(id));
  }
  expiredGuests(){return this.db.prepare("SELECT id FROM users WHERE role='guest' AND expires<=?").all(Date.now());}
  purgeGuests(){
    this.db.exec('BEGIN');try{
      for(const {id} of this.expiredGuests()){for(const table of ['sessions','ownership','usage','user_ai_configs'])this.db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(id);this.db.prepare('DELETE FROM users WHERE id=?').run(id);}
      this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  async login(username,password){
    const u=this.db.prepare('SELECT * FROM users WHERE username=?').get(String(username||'').toLowerCase());
    // Perform the same expensive operation even for unknown accounts.
    const [salt,hash]=(u?.password||'00000000000000000000000000000000:'+('00'.repeat(64))).split(':');
    const supplied=await scrypt(String(password||'').slice(0,128),salt,64);
    if(!u?.active||u.role==='guest'||!timingSafeEqual(supplied,Buffer.from(hash,'hex')))return null;
    return this.issueSession(u);
  }
  token(req){return (req.headers.cookie||'').match(/(?:^|;\s*)drawguess_auth=([a-f0-9]{64})(?:;|$)/)?.[1];}
  authenticate(req){const token=this.token(req);if(!token)return null;return this.db.prepare('SELECT u.* FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.token=? AND s.expires>? AND u.active=1 AND (u.expires IS NULL OR u.expires>?)').get(digest(token),Date.now(),Date.now())||null;}
  logout(req){const token=this.token(req);if(token)this.db.prepare('DELETE FROM sessions WHERE token=?').run(digest(token));}
  cookie(token,secure,guest=false){return `drawguess_auth=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token?(guest?86400:this.sessionDays*86400):0}${secure?'; Secure':''}`;}
  async update(id,{active,password},actorId){
    const user=this.get(id);if(!user)throw new Error('账号不存在。');
    if(active!==undefined&&typeof active!=='boolean')throw new Error('账号状态无效。');
    if(id===actorId&&active===false)throw new Error('不能停用当前管理员账号。');
    const hash=password?await this.password(password):null;
    if(hash)this.db.prepare('UPDATE users SET password=? WHERE id=?').run(hash,id);
    if(active!==undefined)this.db.prepare('UPDATE users SET active=? WHERE id=?').run(Number(active),id);
    this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    return publicUser(this.get(id));
  }
  own(gameId,userId){this.db.prepare('INSERT OR IGNORE INTO ownership VALUES(?,?)').run(gameId,userId);}
  canRead(gameId,user){return user.role==='admin'||!!this.db.prepare('SELECT 1 FROM ownership WHERE game_id=? AND user_id=?').get(gameId,user.id);}
  defaults(){return JSON.parse(this.db.prepare("SELECT value FROM settings WHERE key='defaults'").get()?.value||'{}');}
  saveDefaults(value){this.db.prepare("INSERT INTO settings VALUES('defaults',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));}
  charge(userId,kind){
    if(!['matches','calls'].includes(kind))throw new Error('额度类型无效。');
    const day=new Date().toISOString().slice(0,10),limit=kind==='matches'?this.maxDailyMatches:this.maxDailyCalls;
    this.db.exec('BEGIN IMMEDIATE');try{
      this.db.prepare('INSERT OR IGNORE INTO usage(user_id,day) VALUES(?,?)').run(userId,day);
      const r=this.db.prepare(`UPDATE usage SET ${kind}=${kind}+1 WHERE user_id=? AND day=? AND ${kind}<?`).run(userId,day,limit);
      if(!r.changes)throw new Error(kind==='matches'?'今天的开局次数已用完，请明天再来。':'今天的 AI 调用额度已用完，请联系管理员。');
      if(kind==='calls'){
        this.db.prepare('INSERT OR IGNORE INTO usage(user_id,day) VALUES(?,?)').run('__site__',day);
        const total=this.db.prepare('UPDATE usage SET calls=calls+1 WHERE user_id=? AND day=? AND calls<?').run('__site__',day,this.maxDailyTotalCalls);
        if(!total.changes)throw new Error('今天的全站 AI 调用额度已用完，请联系管理员。');
      }
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  close(){this.db.close();}
}
