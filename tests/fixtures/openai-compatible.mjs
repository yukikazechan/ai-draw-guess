import http from 'node:http';
import {once} from 'node:events';

// Local-only compatible API fixture. It never contacts a model provider.
export async function startCompatibleFixture(port=0){
  const gates=new Map();
  const calls=[];let failBanter=false,guess='固定错误答案';
  const shapes=[{type:'ellipse',x:350,y:315,rx:165,ry:135,color:'#306b44',fill:'#b7da65',width:6},{type:'ellipse',x:650,y:315,rx:130,ry:110,color:'#ba553c',fill:'#ffcf88',width:6}];
  const server=http.createServer(async(req,res)=>{
    try{
      let raw='';for await(const part of req)raw+=part;
      const body=JSON.parse(raw),prompt=(body.messages||[]).flatMap(m=>typeof m.content==='string'?[m.content]:(m.content||[]).filter(c=>c.type==='text').map(c=>c.text)).join('\n');
      const purpose=/"line"\s*:/.test(prompt)?'banter':prompt.includes('"summary"')?'recap':prompt.includes('"append"')||prompt.includes('"shapes"')?'draw':'guess';
      calls.push({purpose,prompt,model:body.model,authorization:req.headers.authorization});
      if(gates.has(purpose))await gates.get(purpose).promise;
      if(purpose==='banter'&&failBanter){res.writeHead(503,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'fixture upstream failure'}}));return;}
      const result=purpose==='banter'?{line:'我看见了画里的轮廓，你这句吐槽我可记住了。'}:purpose==='recap'?{summary:'我把圆形线索看偏了。'}:purpose==='draw'?(prompt.includes('"undo"')?{undo:0,append:[{type:'line',points:[[350,180],[365,135]],color:'#5c7840',width:8}],hint:null,hints:{}}:{shapes,hint:null,hints:{}}):{guess,reason:'我按圆形轮廓猜测',confidence:82};
      res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}));
    }catch{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'invalid fixture request'}}));}
  });
  server.listen(port,'127.0.0.1');await once(server,'listening');
  return {server,calls,base:`http://127.0.0.1:${server.address().port}/v1`,hold(purpose){if(gates.has(purpose))throw new Error('Fixture already held');let release;const promise=new Promise(resolve=>{release=()=>{gates.delete(purpose);resolve();};});gates.set(purpose,{promise,release});return release;},setFailBanter(value){failBanter=value;},setGuess(value){guess=value;},close(){for(const gate of gates.values())gate.release();return new Promise(resolve=>server.close(resolve));}};
}
