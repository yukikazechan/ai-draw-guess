import {CharacterView} from './avatar-loader.mjs';
import {seatCharacter,seatPresentation,tablePlaces} from './seat-presentation.mjs';
import {latestSpeech,messageBody,messageLabel} from './conversation.mjs';
import {playerModelLabel,playerLabel} from './characters.mjs';
import {normalizeConfidence} from './guess-confidence.mjs';
import {roundAnswerMarkup} from './round-results.mjs';


const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export function createPlayerSeats(container,{View=CharacterView,onPreparation=()=>{},previewContainer=null}={}){
  const seats=new Map();let gameId=null,paused=false,prepared=[],active=false;
  const suspended=seat=>(!active&&!previewContainer)||!seat.visible;
  const visibility=typeof IntersectionObserver==='undefined'?null:new IntersectionObserver(entries=>{for(const entry of entries){const seat=seats.get(entry.target.dataset.playerId);if(seat){seat.visible=entry.isIntersecting;seat.view?.setSuspended?.(suspended(seat));}}},{threshold:0.01});
  // Keep initialized canvases connected and sized while the lobby is visible.
  const parking=previewContainer||document.createElement('div');
  if(!previewContainer){parking.className='seat-preload-parking';parking.setAttribute('aria-hidden','true');parking.inert=true;document.body.append(parking);}
  function renderPrepared(){
    if(active||!previewContainer)return;
    for(const player of prepared){
      const seat=seats.get(player.id);if(!seat)continue;const {card}=seat;
      card.setAttribute('aria-label',playerLabel(player)+' · 已选 AI 预览');card.dataset.state='idle';
      card.classList.remove('is-artist','solved');card.style.setProperty('--p-color',player.color||'#344fd2');
      card.querySelector('.seat-name').textContent=player.name;
      const model=card.querySelector('.seat-model');model.textContent=playerModelLabel(player);model.title=playerModelLabel(player);model.hidden=false;
      card.querySelector('.seat-score').hidden=true;card.querySelector('.seat-dialogue').hidden=true;card.querySelector('.seat-confidence').hidden=true;
      card.querySelector('.seat-role').textContent='已选 AI';card.querySelector('.seat-status').textContent={loading:'角色准备中',ready:'角色已就绪',error:'加载失败，可重试'}[seat.status];
      card.querySelector('.seat-answers').replaceChildren();card.querySelector('.seat-feedback').replaceChildren();seat.view?.setState('idle');
    }
  }
  function report(){renderPrepared();const chosen=prepared.map(p=>seats.get(p.id)).filter(Boolean);onPreparation({total:prepared.length,ready:chosen.filter(s=>s.status==='ready').length,failed:chosen.filter(s=>s.status==='error').length});}
  function remove(id){const seat=seats.get(id);visibility?.unobserve(seat.card);seat.view?.destroy();seat.card.remove();seats.delete(id);}
  function clear(){for(const id of seats.keys())remove(id);visibility?.disconnect();gameId=null;if(!previewContainer)parking.remove();}
  function mount(player,character,home){
    const card=document.createElement('article');
    card.className=player.human?'player-seat human-seat':'player-seat ai-seat';card.dataset.playerId=player.id;
    card.innerHTML='<header><div class="seat-identity"><strong class="seat-name"></strong><small class="seat-model"></small></div><span class="seat-score"></span></header><div class="seat-stage"></div><div class="seat-dialogue" hidden></div><div class="seat-caption"><span class="seat-role"></span><span class="seat-status"></span><span class="seat-confidence" hidden></span></div><div class="seat-answers" aria-label="本题各轮答案"></div><div class="seat-feedback"></div>';
    const seat={card,characterId:character?.id,modelUrl:character?.modelUrl,view:null,feedbackKey:'',status:'loading',visible:true};seats.set(player.id,seat);home.append(card);visibility?.observe(card);
    if(character){
      const stage=card.querySelector('.seat-stage');
      stage.innerHTML='<canvas></canvas><span class="seat-fallback" aria-hidden="true" hidden></span><span class="seat-loading" role="status">加载中…</span><button class="seat-retry" hidden>重试</button>';
      const canvas=stage.querySelector('canvas'),loading=stage.querySelector('.seat-loading'),retry=stage.querySelector('button'),fallback=stage.querySelector('.seat-fallback');
      fallback.textContent=Array.from(player.name||character.name||'AI')[0].toUpperCase();retry.setAttribute('aria-label',`重新加载 ${player.name} 的角色`);retry.title='角色暂未加载，点击重试；游戏可以继续。';
      canvas.setAttribute('aria-label',`${player.name} 的 Live2D 角色`);card.dataset.character=character.id;
      seat.load=()=>{
        seat.view?.destroy();const next=canvas.cloneNode();next.hidden=false;stage.querySelector('canvas').replaceWith(next);loading.hidden=false;loading.textContent='加载中…';retry.hidden=true;fallback.hidden=true;stage.dataset.loadState='loading';
        seat.status='loading';report();
        const view=new View(next,{modelUrl:character.modelUrl,motion:character.motion,framing:'portrait',onReady:()=>{if(seat.view!==view||seats.get(player.id)!==seat)return;loading.hidden=true;stage.dataset.loadState='ready';seat.status='ready';report();},onError:()=>{if(seat.view!==view||seats.get(player.id)!==seat)return;next.hidden=true;loading.hidden=true;fallback.hidden=false;retry.hidden=false;stage.dataset.loadState='error';seat.status='error';report();}});
        seat.view=view;view.setState(card.dataset.state||'idle');view.setPaused(paused);view.setSuspended?.(suspended(seat));view.load();
      };
      retry.onclick=seat.load;seat.load();
    }else{card.querySelector('.seat-stage').remove();const mark=document.createElement('span');mark.className='human-mark';mark.setAttribute('aria-hidden','true');mark.textContent='✎';card.append(mark);}
    return seat;
  }
  function reconcile(players,home){
    const ids=new Set(players.map(p=>p.id));for(const id of seats.keys())if(!ids.has(id))remove(id);
    for(const [i,player] of players.entries()){
      const character=seatCharacter(player);let seat=seats.get(player.id);
      if(seat&&(seat.characterId!==character?.id||seat.modelUrl!==character?.modelUrl)){remove(player.id);seat=null;}
      seat||=mount(player,character,home);
      if(home.children[i]!==seat.card)home.insertBefore(seat.card,home.children[i]||null);
      seat.view?.setSuspended?.(suspended(seat));
    }
  }
  function prepare(players){prepared=players.filter(p=>!p.human);if(!active)reconcile(prepared,parking);report();}
  function retryPrepared(){if(active)return;for(const seat of seats.values())if(seat.status==='error')seat.load?.();}
  function update(game,animating=false){
    if(!game||game.phase==='finished'){
      if(active){active=false;gameId=null;reconcile(prepared,parking);report();}
      return;
    }
    active=true;const changed=gameId!==game.id;gameId=game.id;reconcile(game.players,container);
    const places=tablePlaces(game.players,game.viewerId);
    // Stable seats and canvases survive polling, scoring and artist changes.
    for(const player of game.players){
      const character=seatCharacter(player),seat=seats.get(player.id);
      const {card}=seat,presentation=seatPresentation(game,player,animating),r=presentation.result;
      if(changed)seat.feedbackKey='';
      card.dataset.place=places.get(player.id);
      card.style.setProperty('--p-color',player.color||character?.color||'#67738f');
      card.setAttribute('aria-label',`${playerLabel(player)} · ${presentation.role}`);
      card.dataset.state=presentation.state;card.classList.toggle('is-artist',presentation.artist);card.classList.toggle('solved',!!r?.solved);
      card.querySelector('.seat-name').textContent=player.name;
      card.querySelector('.seat-model').textContent=playerModelLabel(player);
      card.querySelector('.seat-model').title=playerModelLabel(player);
      card.querySelector('.seat-model').hidden=!!player.human;
      card.querySelector('.seat-score').textContent=game.mode==='relay'?`第 ${game.index+1} 棒`:`${presentation.total} 分`;
      card.querySelector('.seat-score').hidden=false;
      card.querySelector('.seat-role').textContent=(player.id===(game.viewerId||'human')?'你 · ':player.human?'真人 · ':'')+presentation.role;
      card.querySelector('.seat-status').textContent=presentation.status;
      const confidence=normalizeConfidence(r?.confidence),label=card.querySelector('.seat-confidence');
      label.hidden=player.human||confidence===null||['waiting','thinking','queued'].includes(r?.status);
      label.textContent=confidence===null?'':`把握 ${confidence}%`;
      label.title='AI 根据画面自报的主观把握';
      const answers=card.querySelector('.seat-answers'),markup=roundAnswerMarkup((r?.history||[]).filter(h=>!player.human||h.turn<game.turn||['review','reveal'].includes(game.phase)),escape);
      if(answers.innerHTML!==markup)answers.innerHTML=markup;
      seat.view?.setState(presentation.state);
      const speech=latestSpeech(game,player.id),key=JSON.stringify([speech,r?.error]);
      if(key!==seat.feedbackKey){
        seat.feedbackKey=key;
        const dialogue=card.querySelector('.seat-dialogue');dialogue.hidden=!speech;
        if(speech){dialogue.dataset.kind=speech.kind;dialogue.tabIndex=0;dialogue.setAttribute('aria-label',`${player.name} 的消息`);dialogue.innerHTML=`<span class="speech-label">${escape(messageLabel(speech))}</span>${messageBody(speech)}`;}
        card.querySelector('.seat-feedback').innerHTML=r?.error?`<div class="error-message">${escape(r.error)}</div>`:'';
      }
    }
  }
  function setPaused(value){paused=value;for(const seat of seats.values())seat.view?.setPaused(paused);}
  addEventListener('pagehide',clear,{once:true});
  return {update,prepare,retryPrepared,setPaused,destroy:clear};
}
