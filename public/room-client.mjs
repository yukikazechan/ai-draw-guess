// The existing arena owns presentation; this adapter only transports room state.
export function createRoomClient({request,onChange=()=>{},onConnection=()=>{},onError=()=>{},Socket=globalThis.WebSocket,url=globalThis.location}){
  let room=null,socket=null,active=false,epoch=0,mutating=false,reconnectTimer,drawTimer,pending=null,lastDraw=0,connected=false;
  function connection(value,text){connected=value;onConnection(value,text);}
  function adopt(next){
    if(next&&room?.id===next.id&&(next.version||0)<(room.version||0))return;
    room=next;onChange(room);
  }
  function cancelDrawing(){clearTimeout(drawTimer);pending=null;}
  function closeSocket(){clearTimeout(reconnectTimer);cancelDrawing();const old=socket;socket=null;old?.close();connection(false,'正在连接房间…');}
  function connect(){
    closeSocket();if(!active||!room)return;
    const ws=new Socket(`${url.protocol==='https:'?'wss:':'ws:'}//${url.host}/ws/room`);socket=ws;
    ws.onopen=()=>{if(socket===ws)connection(true,'已实时连接 · 笔画自动同步');};
    ws.onmessage=event=>{
      if(socket!==ws)return;
      try{const data=JSON.parse(event.data);if(data.type==='state')adopt(data.room);else if(data.type==='error')onError(data.error);}
      catch{onError('房间同步失败，正在重新连接。');ws.close();}
    };
    ws.onclose=()=>{if(socket!==ws)return;socket=null;cancelDrawing();connection(false,'连接断开，正在重连…');reconnectTimer=setTimeout(async()=>{try{await refresh();}catch(e){onError(e.message);}if(active&&room)connect();},1800);};
    ws.onerror=()=>{if(socket===ws)connection(false,'实时连接不可用，正在重试…');};
  }
  async function refresh(){if(mutating)return;const token=epoch,data=await request('/api/rooms/state');if(!active||token!==epoch)return;adopt(data.room);if(!room&&socket)closeSocket();}
  async function enter(code){active=true;const token=++epoch;await refresh();if(token!==epoch)return;if(room&&code&&room.id!==String(code).trim().toUpperCase()){connect();throw new Error('你已在房间 '+room.id+'，请先离开，再打开新的邀请链接。');}if(!room&&code){const data=await request('/api/rooms/join',{code});if(token!==epoch)return;adopt(data.room);}if(room)connect();}
  async function mutate(path,data){
    if(mutating)throw new Error('上一项操作尚未完成，请稍候。');
    mutating=true;const token=++epoch;
    try{const result=await request(path,data);if(!active||token!==epoch)return;if('room' in result)adopt(result.room);return result;}
    finally{mutating=false;}
  }
  async function create(){await mutate('/api/rooms/create',{});connect();}
  async function join(code){await mutate('/api/rooms/join',{code});connect();}
  async function leave(){await mutate('/api/rooms/leave',{});epoch++;closeSocket();adopt(null);}
  async function start(options){cancelDrawing();await mutate('/api/rooms/start',options);}
  async function lobby(options){return mutate('/api/rooms/lobby',options);}
  async function chat(text,targetId=''){await request('/api/rooms/chat',{text,targetId});await refresh();}
  async function action(action,extra={}){
    const g=room?.game;if(!g)return;
    cancelDrawing();await mutate('/api/rooms/action',{gameId:g.id,index:g.index,turn:g.turn,action,...extra});await refresh();
  }
  function flushDrawing(){
    clearTimeout(drawTimer);const data=pending;pending=null;
    const g=room?.game;if(!data||!connected||socket?.readyState!==1||!g||g.phase!=='drawing'||data.gameId!==g.id||data.index!==g.index||data.turn!==g.turn)return;
    const json=JSON.stringify(data);if(json.length>240000){onError('画作过大，请撤销部分笔画后再继续。');return;}
    socket.send(json);lastDraw=Date.now();
  }
  function drawing(shapes){
    const g=room?.game;if(!active||!connected||g?.phase!=='drawing')return;
    pending={type:'drawing',gameId:g.id,index:g.index,turn:g.turn,shapes:structuredClone(shapes)};
    clearTimeout(drawTimer);drawTimer=setTimeout(flushDrawing,Math.max(0,90-(Date.now()-lastDraw)));
  }
  function suspend(){active=false;epoch++;closeSocket();}
  return {get room(){return room;},get connected(){return connected;},enter,refresh,create,join,leave,start,lobby,chat,action,drawing,suspend};
}
