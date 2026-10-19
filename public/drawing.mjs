export const W = 1000, H = 650;
export class DrawingHistory {
  constructor(){this.operations=[];}
  reset(){this.operations=[];}
  stroke(length){this.operations.push({type:'stroke',length});}
  clear(shapes){if(shapes.length)this.operations.push({type:'clear',shapes:structuredClone(shapes)});return [];}
  undo(shapes){const operation=this.operations.pop();return !operation?shapes:operation.type==='clear'?operation.shapes:shapes.slice(0,operation.length);}
}
export function drawShape(ctx, s) {
  if(s.type==='bucket'){
    const matrix=ctx.getTransform(),x=Math.round(s.x*matrix.a+s.y*matrix.c+matrix.e),y=Math.round(s.x*matrix.b+s.y*matrix.d+matrix.f);
    const image=ctx.getImageData(0,0,ctx.canvas.width,ctx.canvas.height);
    if(floodFill(image.data,image.width,image.height,x,y,s.color))ctx.putImageData(image,0,0);
    return;
  }
  ctx.save(); ctx.strokeStyle=s.color||'#202633'; ctx.fillStyle=s.fill||'transparent';
  ctx.lineWidth=s.width||5; ctx.lineCap='round';ctx.lineJoin='round';ctx.beginPath();
  if (s.type === 'ellipse') ctx.ellipse(s.x,s.y,s.rx,s.ry,0,0,Math.PI*2);
  else if (s.type === 'rect') ctx.rect(s.x,s.y,s.w,s.h);
  else { (s.points||[]).forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y)); if(s.type==='polygon')ctx.closePath(); }
  if (s.fill && s.fill !== 'none')ctx.fill(); if(s.color !== 'none') ctx.stroke(); ctx.restore();
}
export function paint(canvas, shapes) { const c=canvas.getContext('2d');c.fillStyle='#fff';c.fillRect(0,0,canvas.width,canvas.height);c.save();c.scale(canvas.width/W,canvas.height/H);shapes.forEach(s=>drawShape(c,s));c.restore(); }
export function png(shapes) { const c=document.createElement('canvas');c.width=W;c.height=H;paint(c,shapes);return c.toDataURL('image/png'); }

// Four-connected fill is stored as a seed + color, so undo, rooms and replays
// share the same compact operation without sending image blobs or polygons.
export function floodFill(data,width,height,x,y,color,tolerance=24){
  if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||x>=width||y>=height||!/^#[0-9a-f]{6}$/i.test(color))return 0;
  const start=(y*width+x)*4,target=[...data.slice(start,start+4)],rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16));
  if(target.slice(0,3).every((v,i)=>v===rgb[i])&&target[3]===255)return 0;
  const visited=new Uint8Array(width*height),queue=new Uint32Array(width*height);let head=0,tail=1,filled=0;queue[0]=y*width+x;visited[queue[0]]=1;
  const matches=i=>Math.max(Math.abs(data[i]-target[0]),Math.abs(data[i+1]-target[1]),Math.abs(data[i+2]-target[2]),Math.abs(data[i+3]-target[3]))<=tolerance;
  while(head<tail){
    const pixel=queue[head++],i=pixel*4;if(!matches(i))continue;
    data[i]=rgb[0];data[i+1]=rgb[1];data[i+2]=rgb[2];data[i+3]=255;filled++;
    const col=pixel%width;
    const push=p=>{if(!visited[p]){visited[p]=1;queue[tail++]=p;}};
    if(col>0)push(pixel-1);if(col+1<width)push(pixel+1);if(pixel>=width)push(pixel-width);if(pixel+width<width*height)push(pixel+width);
  }
  return filled;
}
