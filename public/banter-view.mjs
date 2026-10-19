import {escapeText as esc} from './conversation.mjs';
export const banterPending=b=>!!b&&!['complete','empty','skipped'].includes(b.status);
export function banterMarkup(b,{controls=true}={}){
 if(!b)return '';
 const e=b.exchanges[b.index],waiting=b.status==='waiting-human';
 const status={empty:'这回大家暂时休战。',complete:'这一轮回嘴结束，聊天记录已保留。',skipped:'已跳过剩余互怼，已说的内容保留。',error:e?.error,waiting:'准备开麦…','waiting-human':`${e?.fromName||'对方'} 点了你的名，轮到你回嘴了。`,working:e?.status==='replying'?`${e.toName} 正在回嘴…`:`${e?.fromName||'选手'} 正在组织语言…`}[b.status]||'';
 const speech=(name,target,text,reply)=>`<article class="banter-line ${reply?'banter-reply':''}"><header><strong>${esc(name)}</strong><span>→ ${esc(target)} · ${reply?'回应':'开麦'}</span></header><p>${esc(text)}</p></article>`;
 return `<section class="round-banter" data-banter-id="${esc(b.id)}"><header class="banter-heading"><h3>赛后互怼</h3><span>随机点名 · 也可以主动 @ AI</span></header>${b.exchanges.map(x=>`<div class="banter-exchange">${x.opener?speech(x.fromName,x.toName,x.opener,false):''}${x.reply?speech(x.toName,x.fromName,x.reply,true):''}</div>`).join('')}<p class="banter-status" role="status">${esc(status)}</p>${controls&&waiting?`<form data-banter-form data-exchange-id="${esc(e.id)}"><label for="banter-${esc(e.id)}">你来回应 ${esc(e.fromName)}</label><div class="banter-input-row"><input id="banter-${esc(e.id)}" data-banter-input maxlength="120" autocomplete="off" placeholder="别替我说，让我自己来！"><button type="submit" class="primary">回嘴</button></div></form>`:''}${controls&&banterPending(b)?`<div class="button-row">${b.status==='error'?'<button data-banter-action="retry">重试这一句</button>':''}<button data-banter-action="skip">跳过剩余互怼</button></div>`:''}</section>`;
}
export function banterComposerMarkup(game,viewerId='human'){
 const b=game?.banter,players=game?.players||[],ais=players.filter(p=>!p.human);
 if(game?.phase!=='reveal'||!game.banterEnabled||!b||!ais.length||!players.some(p=>p.id===viewerId&&p.human))return '';
 const current=b.exchanges[b.index],waiting=b.status==='waiting-human',remaining=3-b.exchanges.filter(e=>e.manual&&e.fromId===viewerId).length;
 if(waiting&&current?.toId===viewerId)return `<form class="banter-composer-form" data-banter-form data-banter-id="${esc(b.id)}" data-exchange-id="${esc(current.id)}"><label for="banter-chat-${esc(current.id)}">@${esc(current.fromName)} 点了你，回应她</label><div class="banter-input-row"><input id="banter-chat-${esc(current.id)}" data-banter-input maxlength="120" autocomplete="off" placeholder="输入你的回应"><button class="primary" type="submit">回嘴</button></div></form>`;
 const ready=['empty','complete'].includes(b.status)&&remaining>0;
 const help=ready?`AI 会按本局画面和真实作答回应 · 本题还可主动发起 ${remaining} 次`:waiting?`等待 ${current?.toName||'玩家'} 回应 ${current?.fromName||'AI'}`:b.status==='error'?'AI 回应失败，请在互动面板重试或跳过。':b.status==='skipped'?'本题互动已结束，下一题可以继续。':remaining<=0?'本题已主动发起 3 次，下一题可以继续。':'AI 正在组织回应，稍后可以继续发送。';
 return `<form class="banter-composer-form" data-banter-challenge data-banter-id="${esc(b.id)}"><label for="banter-message-${esc(b.id)}">揭晓后 @ AI，直接开麦</label><div class="banter-compose-row"><select id="banter-target-${esc(b.id)}" data-banter-target aria-label="选择要互怼的 AI">${ais.map(p=>`<option value="${esc(p.id)}">@${esc(p.name)}</option>`).join('')}</select><input id="banter-message-${esc(b.id)}" data-banter-input maxlength="120" autocomplete="off" placeholder="想对这位 AI 说点什么？"><button class="primary" type="submit"${ready?'':' disabled'}>发送互怼</button></div><small role="status">${esc(help)}</small></form>`;
}
export function bindBanterControls(container,act){
 container.addEventListener('submit',async event=>{
  const challenge=event.target.closest('[data-banter-challenge]');
  if(challenge){event.preventDefault();const input=challenge.querySelector('[data-banter-input]'),text=input.value.trim();if(!text)return;const button=challenge.querySelector('button');if(button.disabled)return;button.disabled=true;
   try{const sent=await act('banter-challenge',{banterId:challenge.dataset.banterId,targetId:challenge.querySelector('[data-banter-target]').value,text});if(sent!==false){const live=container.querySelector('[data-banter-challenge] [data-banter-input]');if(live?.value===text)live.value='';}}
   finally{if(button.isConnected)button.disabled=false;}return;
  }
  const form=event.target.closest('[data-banter-form]');if(!form)return;event.preventDefault();
  const text=form.querySelector('[data-banter-input]').value.trim();if(!text)return;
  const button=form.querySelector('button');button.disabled=true;
  try{await act('banter-reply',{banterId:form.closest('[data-banter-id]').dataset.banterId,exchangeId:form.dataset.exchangeId,text});}finally{if(button.isConnected)button.disabled=false;}
 });
 container.addEventListener('click',async event=>{
  const button=event.target.closest('[data-banter-action]');if(!button)return;button.disabled=true;
  try{await act('banter-'+button.dataset.banterAction,{banterId:button.closest('[data-banter-id]').dataset.banterId});}finally{if(button.isConnected)button.disabled=false;}
 });
}
export function captureBanterDraft(container){
 return [...container.querySelectorAll('[data-banter-input],[data-banter-target]')].map(input=>({id:input.id,value:input.value,focused:input===document.activeElement,start:input.selectionStart,end:input.selectionEnd}));
}
export function restoreBanterDraft(container,draft){
 for(const value of Array.isArray(draft)?draft:draft?[draft]:[]){const input=[...container.querySelectorAll('[data-banter-input],[data-banter-target]')].find(n=>n.id===value.id);if(!input)continue;
 input.value=value.value;if(value.focused){input.focus({preventScroll:true});if(input.setSelectionRange)input.setSelectionRange(value.start,value.end);}}
}
