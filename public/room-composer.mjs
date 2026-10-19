export function roomComposerState(room,viewerId){
  const game=room?.game,banter=game?.phase==='reveal'?game.banter:null,current=banter?.exchanges[banter.index];
  const reply=banter?.status==='waiting-human'&&current?.toId===viewerId?current:null;
  const remaining=3-(banter?.exchanges||[]).filter(e=>e.manual&&e.fromId===viewerId).length;
  const aiReady=!!(game?.banterEnabled&&banter&&['empty','complete'].includes(banter.status)&&remaining>0);
  const targets=[{id:'',name:'所有人',kind:'all',disabled:false},
    ...(room?.members||[]).filter(p=>p.id!==viewerId).map(p=>({id:p.id,name:p.name,kind:'human',disabled:false})),
    ...(game?.players||[]).filter(p=>!p.human).map(p=>({id:p.id,name:p.name,kind:'ai',disabled:!aiReady&&reply?.fromId!==p.id}))];
  let hint='公开聊天 · 选择 @ 对象，或直接对大家说';
  if(reply)hint=`${reply.fromName} 点了你，直接输入回应`;
  else if(banter?.status==='working')hint=`${current?.status==='replying'?current.toName:current?.fromName||'AI'} 正在回应，可继续与大家聊天`;
  else if(banter?.status==='waiting-human')hint=`等待 ${current?.toName||'玩家'} 回应；房间聊天照常开放`;
  else if(banter?.status==='error')hint='AI 回应失败，可重试；房间聊天照常开放';
  else if(aiReady)hint=`公开聊天 · @ AI 会接着本题回应，还可发起 ${remaining} 次`;
  else if(game&&game.phase!=='reveal'&&game.phase!=='finished')hint='公开聊天 · 揭晓后可 @ AI，请勿剧透';
  else if(remaining<=0)hint='本题已 @ AI 3 次，仍可继续与真人聊天';
  return {targets,reply,aiReady,hint,banterId:banter?.id,retry:banter?.status==='error'&&!!(current?.manual&&(current.fromId===viewerId||room.hostId===viewerId))};
}

export function roomMessageAction(room,viewerId,targetId,text){
  const state=roomComposerState(room,viewerId),target=state.targets.find(p=>p.id===targetId);
  if(!target||target.disabled)throw new Error('当前不能向这位 AI 发起互动，请先对大家说。');
  if(state.reply&&state.reply.fromId===targetId)return {action:'banter-reply',extra:{banterId:state.banterId,exchangeId:state.reply.id,text}};
  if(target.kind==='ai')return {action:'banter-challenge',extra:{banterId:state.banterId,targetId,text}};
  return {action:'chat',extra:{targetId,text}};
}
