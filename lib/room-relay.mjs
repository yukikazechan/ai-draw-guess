import {RelayGame} from './relay.mjs';
import {validateShapes} from './shapes.mjs';

export class RoomRelayGame extends RelayGame{
  constructor(options){super({...options,human:false,autoRecover:true,banter:false});}
  saveDraft(playerId,data){
    const task=this.tasks.get(playerId);
    if(this.phase!=='relay-work'||!this.players.some(p=>p.id===playerId&&p.human)||task?.kind!=='draw'||task.status!=='waiting'||data.index!==this.index||data.chainId!==task.chainId)throw new Error('这张接龙画布不属于你，或已经提交。');
    const shapes=Array.isArray(data.shapes)&&!data.shapes.length?[]:validateShapes(data.shapes);
    this.drafts.set(playerId,shapes);this.touch();
  }
  // Shared rooms reveal all chains together; no host-only playback can expose
  // a different intermediate answer to different viewers.
  finish(){super.finish({showcase:false});}
  snapshot(viewerId){const s=super.snapshot(viewerId);s.viewerId=viewerId;s.viewerRole=this.players.some(p=>p.human&&p.id===viewerId)?'player':'spectator';s.recordingEnabled=s.viewerRole==='player'&&!!this.recording;s.clock=this.clock?{...this.clock,serverNow:Date.now()}:null;return s;}
}
