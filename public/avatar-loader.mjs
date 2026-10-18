class UnavailableCharacterView {
  constructor(_canvas,options={}){this.options=options;this.destroyed=false;}
  load(){queueMicrotask(()=>{if(!this.destroyed)this.options.onError?.(new Error('Live2D 资源尚未安装，AI 配置与游戏仍可使用。'));});return Promise.resolve();}
  setState(){}setPaused(){}setSuspended(){}destroy(){this.destroyed=true;}
}
let CharacterView=UnavailableCharacterView;
if(globalThis.Live2DCubismCore){try{({CharacterView}=await import('./avatar-renderer.mjs'));}catch{}}
export {CharacterView};
