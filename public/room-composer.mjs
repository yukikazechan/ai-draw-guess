export function roomComposerState(room,viewerId){
  if(!room?.game||room.game.phase==='finished'){
    const job=room?.aiChat,busy=job?.status==='working';
    const targets=[{id:'',name:'所有人',kind:'all',disabled:false},
      ...(room?.members||[]).filter(p=>p.id!==viewerId).map(p=>({id:p.id,name:p.name,kind:'human',disabled:false})),
      ...(room?.lobby?.players||[]).map(p=>({id:p.id,name:p.name,kind:'ai',disabled:busy}))];
    const hint=busy?`${job.targetName} 正在回应，可继续与真人聊天`:job?.status==='error'?'AI 回应失败，可以重试或继续聊天':targets.some(p=>p.kind==='ai')?'公开聊天 · 开局前也可 @ 已选 AI 聊天':'公开聊天 · 房主选择 AI 后即可 @ 对话';
    return {preparing:true,targets,reply:null,aiReady:!busy&&targets.some(p=>p.kind==='ai'),hint,chatId:job?.id,retry:job?.status==='error'&&(job.fromId===viewerId||room.hostId===viewerId)};
  }
  const game=room?.game,banter=game?.phase==='reveal'?game.banter:null,current=banter?.exchanges[banter.index];
  if(game?.mode==='undercover'&&!game.players.some(p=>p.id===viewerId&&p.alive))return {preparing:false,targets:[{id:'',name:'所有人',kind:'all',disabled:true}],reply:null,aiReady:false,blocked:true,hint:'本局结束前，观战与出局玩家只能观看，避免剧透。'};
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
  else if(game?.mode==='undercover')hint='公开聊天 · 正式描述和投票请使用牌桌操作区';
  else if(game&&game.phase!=='reveal'&&game.phase!=='finished')hint='公开聊天 · 揭晓后可 @ AI，请勿剧透';
  else if(remaining<=0)hint='本题已 @ AI 3 次，仍可继续与真人聊天';
  return {preparing:false,targets,reply,aiReady,hint,banterId:banter?.id,retry:banter?.status==='error'&&!!(current?.manual&&(current.fromId===viewerId||room.hostId===viewerId))};
}

export function roomMessageAction(room,viewerId,targetId,text){
  const state=roomComposerState(room,viewerId),target=state.targets.find(p=>p.id===targetId);
  if(!target||target.disabled)throw new Error('当前不能向这位 AI 发起互动，请先对大家说。');
  if(state.reply&&state.reply.fromId===targetId)return {action:'banter-reply',extra:{banterId:state.banterId,exchangeId:state.reply.id,text}};
  if(target.kind==='ai')return state.preparing?{action:'lobby-ai',extra:{targetId,text}}:{action:'banter-challenge',extra:{banterId:state.banterId,targetId,text}};
  return {action:'chat',extra:{targetId,text}};
}
export function spectatorProgress(game,host=false){
  const status=host?'你已接任房主 · 本局继续观战':'本局观战 · 下局自动参赛 · 可聊天';
  if(!host)return {action:'',text:'',status};
  if(game?.phase==='reveal')return {action:'next',text:game.index+1===game.total?'查看结果':'下一题',status};
  if(game?.phase==='draw-error')return {action:'retry-draw',text:'重试作画',status:'AI 作画失败 · 你可以重试或跳过本题'};
  return {action:'',text:'',status};
}
