const melodies={
  tap:[[660,.025]],brush:[[760,.018]],fill:[[392,.05],[587,.07,.04]],undo:[[466,.06],[349,.07,.05]],
  send:[[620,.05],[880,.07,.05]],message:[[920,.055],[1150,.065,.06]],
  start:[[523,.08],[659,.08,.09],[784,.13,.18]],round:[[392,.06],[523,.08,.07]],guess:[[659,.07],[880,.1,.08]],
  correct:[[523,.08],[659,.08,.08],[1047,.16,.16]],wrong:[[330,.08],[247,.12,.09]],
  reveal:[[392,.07],[523,.1,.08],[659,.15,.18]],finish:[[523,.09],[659,.09,.1],[784,.09,.2],[1047,.2,.3]],
  tick:[[880,.035]],timeout:[[440,.1],[330,.14,.1]],error:[[196,.1],[185,.1,.12]],sync:[[880,.16]]
};

export function createSoundEngine({Context=globalThis.AudioContext||globalThis.webkitAudioContext,storage,isVisible=()=>!globalThis.document?.hidden,onState=()=>{},onPlay=()=>{}}={}){
  let enabled=true,context=null;const voices=new Set(),last=new Map();
  try{if(storage===undefined)storage=globalThis.localStorage;enabled=storage?.getItem('drawguess.soundEnabled')!=='false';}catch{}
  const state=()=>!Context?'unavailable':!enabled?'muted':context?.state||'locked';
  const report=()=>onState({enabled,state:state()});
  async function unlock(){
    if(!enabled||!Context)return false;
    try{if(!context||context.state==='closed')context=new Context();if(context.state==='suspended')await context.resume();report();return context.state==='running';}catch{report();return false;}
  }
  function play(name){
    const notes=melodies[name];if(!notes||!enabled||!context||context.state!=='running'||!isVisible())return false;
    const now=context.currentTime;if(now-(last.get(name)??-Infinity)<(name==='brush'?.09:.045))return false;last.set(name,now);
    try{
      for(const [frequency,duration,delay=0] of notes){
        if(voices.size>=24)break;
        const oscillator=context.createOscillator(),gain=context.createGain(),start=now+delay,end=start+duration;
        oscillator.type='sine';oscillator.frequency.value=frequency;gain.gain.setValueAtTime(.0001,start);
        gain.gain.linearRampToValueAtTime(name==='tap'||name==='brush'?.018:.065,start+.006);gain.gain.exponentialRampToValueAtTime(.0001,end);
        oscillator.connect(gain);gain.connect(context.destination);voices.add(oscillator);
        oscillator.onended=()=>{voices.delete(oscillator);oscillator.disconnect();gain.disconnect();};oscillator.start(start);oscillator.stop(end+.01);
      }
      onPlay(name);return true;
    }catch{return false;}
  }
  function setEnabled(value){enabled=!!value;try{storage?.setItem('drawguess.soundEnabled',String(enabled));}catch{}if(!enabled)for(const voice of voices){try{voice.stop();}catch{}}report();}
  function close(){for(const voice of voices){try{voice.stop();}catch{}}voices.clear();const old=context;context=null;last.clear();old?.close()?.catch(()=>{});}
  return {get enabled(){return enabled;},get available(){return !!Context;},get state(){return state();},unlock,play,setEnabled,close};
}

// Translate state changes into cues once. Loading or reconnecting a snapshot
// never replays the room's old messages or historical answers.
export function createSoundEvents(){
  let previous=null,clockKey='',clockSecond=null;
  function update({game,room,viewerId='human'}){
    const scope=room?.id||'solo',messages=[...(game?.conversation||[]),...(room?.messages||[])];
    const own=game?.results?.[viewerId],history=own?.history||[];
    const next={scope,id:game?.id||'',index:game?.index,turn:game?.turn,phase:game?.phase,ownCount:history.length,
      messages:new Set(messages.map(m=>m.id)),errors:new Set(Object.entries(game?.results||{}).filter(([,r])=>r.status==='error').map(([id,r])=>id+':'+r.error)),aiJob:room?.aiChat?.id,aiStatus:room?.aiChat?.status,banterId:game?.banter?.id,banterStatus:game?.banter?.status};
    const old=previous;previous=next;if(!old||old.scope!==scope)return null;
    if(next.id&&next.id!==old.id)return 'start';
    if(next.id&&next.id===old.id){
      if(next.phase==='finished'&&old.phase!=='finished')return 'finish';
      if(next.phase==='draw-error'&&old.phase!=='draw-error')return 'error';
      if(next.index!==old.index)return 'round';
      if(history.length>old.ownCount){const last=history.at(-1);if(!last.skipped&&!last.forfeit)return last.correct?'correct':'wrong';}
      if(next.phase==='reveal'&&old.phase!=='reveal')return 'reveal';
      if(next.phase==='guessing'&&old.phase!=='guessing')return 'guess';
      if(next.turn!==old.turn)return 'round';
      if([...next.errors].some(key=>!old.errors.has(key)))return 'error';
    }
    if(next.aiStatus==='error'&&(old.aiStatus!=='error'||old.aiJob!==next.aiJob))return 'error';
    if(next.banterStatus==='error'&&(old.banterStatus!=='error'||old.banterId!==next.banterId))return 'error';
    if(messages.some(m=>!old.messages.has(m.id)&&m.playerId!==viewerId&&(m.kind==='chat'||m.kind==='banter')))return 'message';
    return null;
  }
  function countdown(game,viewerId='human',now=Date.now()){
    const clock=game?.clock,own=game?.results?.[viewerId];
    const affected=clock?.stage==='draw'?game.artistId===viewerId:clock?.stage==='speak'?game.undercover?.speakerId===viewerId:clock?.stage==='vote'?game.players?.some(p=>p.id===viewerId&&p.human&&p.alive)&&!game.undercover?.myVote:clock?.stage?.startsWith('relay-')?game.relay?.myTask?.status==='waiting':clock?.stage==='guess'&&own?.status==='waiting'&&!own.solved;
    if(!affected){clockKey='';clockSecond=null;return null;}
    const key=`${game.id}:${game.index}:${game.turn}:${clock.stage}`;
    const offset=clock.serverNow-(game.clockReceivedAt||now),second=Math.max(0,Math.ceil((clock.deadline-now-offset)/1000));
    if(clockKey!==key){clockKey=key;clockSecond=second;return null;}
    if(second===clockSecond)return null;clockSecond=second;
    return second===0?'timeout':second<=5?'tick':null;
  }
  return {update,countdown};
}
