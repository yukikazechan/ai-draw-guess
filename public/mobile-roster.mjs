export function createMobileRoster({container,section,home}){
  const media=matchMedia('(max-width:800px)'),pages=section.querySelector('[data-roster-pages]'),count=section.querySelector('[data-roster-count]');
  let game=null,total=0,page=0,round='',frame=0,dragFrame=0,indicatorFrame=0,drag=null;
  const stride=()=>container.clientWidth+8;
  function announce(){
    page=Math.max(0,Math.min(total-1,Math.round(container.scrollLeft/Math.max(1,stride()))));
    const text=`${page+1} / ${total}`;if(count.textContent!==text)count.textContent=text;
    for(const [i,dot] of [...pages.children].entries()){const current=String(i===page);if(dot.dataset.current!==current)dot.dataset.current=current;}
  }
  function show(index){container.scrollTo({left:Math.max(0,Math.min(total-1,index))*stride(),behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});}
  function update(value){
    game=value;const active=!!game&&game.phase!=='finished'&&media.matches;
    section.hidden=!active;
    const target=active?section.querySelector('[data-roster-track]'):home;
    if(container.parentElement!==target){if(active)target.append(container);else home.insertBefore(container,home.querySelector('#conversationPanel'));}
    if(!active){round='';return;}
    const size=Math.ceil(game.players.length/2);
    if(size!==total){total=size;pages.replaceChildren();for(let i=0;i<size;i++)pages.append(document.createElement('span'));}
    const key=`${game.id}:${game.index}`;
    if(key!==round){round=key;cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const index=Math.max(0,game.players.findIndex(p=>p.id===game.artistId));container.scrollTo({left:Math.floor(index/2)*stride(),behavior:'instant'});announce();});}
    announce();
  }
  container.tabIndex=0;container.setAttribute('aria-label','选手席，左右滑动或使用左右方向键翻页');
  container.addEventListener('keydown',event=>{if(!media.matches||event.target!==container||!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();show(page+(event.key==='ArrowRight'?1:-1));});
  // Touch uses native scrolling and momentum. Mouse dragging also works in desktop previews.
  container.addEventListener('pointerdown',event=>{
    if(!media.matches||event.pointerType!=='mouse'||event.button!==0||event.target.closest('button,a,input'))return;
    event.preventDefault();drag={id:event.pointerId,x:event.clientX,lastX:event.clientX,time:performance.now(),left:container.scrollLeft,velocity:0,delta:0,moved:false};
    container.style.scrollSnapType='none';container.setPointerCapture(event.pointerId);
  });
  container.addEventListener('pointermove',event=>{
    if(!drag||drag.id!==event.pointerId)return;
    const now=performance.now();drag.velocity=drag.velocity*.5+(drag.lastX-event.clientX)/Math.max(1,now-drag.time)*.5;drag.time=now;drag.lastX=event.clientX;drag.delta=drag.x-event.clientX;
    if(Math.abs(drag.delta)>5)drag.moved=true;
    if(drag.moved){event.preventDefault();if(!dragFrame)dragFrame=requestAnimationFrame(()=>{dragFrame=0;if(drag)container.scrollLeft=drag.left+drag.delta;});}
  });
  const endDrag=()=>{
    if(!drag)return;cancelAnimationFrame(dragFrame);dragFrame=0;
    const old=drag;drag=null;
    if(old.moved)container.scrollLeft=old.left+old.delta;
    container.style.scrollSnapType='';
    if(old.moved){const distance=Math.max(1,stride()),quick=performance.now()-old.time<100&&Math.abs(old.velocity)>.45,advance=quick||Math.abs(old.delta)>distance*.18;show(advance?Math.round(old.left/distance)+(old.delta>0?1:-1):Math.round(container.scrollLeft/distance));}
  };
  container.addEventListener('pointerup',endDrag);container.addEventListener('pointercancel',endDrag);container.addEventListener('lostpointercapture',endDrag);
  container.addEventListener('scroll',()=>{if(!indicatorFrame)indicatorFrame=requestAnimationFrame(()=>{indicatorFrame=0;announce();});},{passive:true});
  media.addEventListener('change',()=>update(game));
  addEventListener('pagehide',()=>{cancelAnimationFrame(frame);cancelAnimationFrame(dragFrame);cancelAnimationFrame(indicatorFrame);},{once:true});
  return {update};
}
