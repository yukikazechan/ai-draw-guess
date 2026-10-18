import {lookup} from 'node:dns/promises';
import {BlockList,isIP} from 'node:net';
import https from 'node:https';

const blocked4=new BlockList(),blocked6=new BlockList(),global6=new BlockList();global6.addSubnet('2000::',3,'ipv6');
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]])blocked4.addSubnet(ip,bits,'ipv4');
for(const [ip,bits] of [['::',96],['::ffff:0:0',96],['64:ff9b::',96],['64:ff9b:1::',48],['100::',64],['2001::',23],['2001:db8::',32],['2002::',16],['fc00::',7],['fe80::',10],['ff00::',8]])blocked6.addSubnet(ip,bits,'ipv6');
export const isPublicAddress=address=>{const type=isIP(address);return type===4?!blocked4.check(address,'ipv4'):type===6&&global6.check(address,'ipv6')&&!blocked6.check(address,'ipv6');};
// Resolve once and pin the approved address to the TLS request, preventing DNS rebinding.
export async function publicApiFetch(input,{method='POST',headers,body,signal}={},dependencies={lookup,request:https.request}){
  const url=new URL(input),host=url.hostname.replace(/^\[|\]$/g,'');
  if(url.protocol!=='https:'||url.username||url.password||url.hash)throw new Error('普通用户的自定义接口必须使用公网 HTTPS 地址。');
  signal?.throwIfAborted();const records=isIP(host)?[{address:host,family:isIP(host)}]:await dependencies.lookup(host,{all:true,verbatim:true});signal?.throwIfAborted();
  if(!records.length||records.some(record=>!isPublicAddress(record.address)))throw new Error('不能连接本机、内网或保留地址，请使用公网 HTTPS 模型接口。');
  const chosen=records.find(record=>record.family===4)||records[0];
  return new Promise((resolve,reject)=>{
    const request=dependencies.request(url,{method,headers,signal,lookup:(_host,options,done)=>options.all?done(null,[chosen]):done(null,chosen.address,chosen.family)},response=>{
      let size=0;const chunks=[];response.on('data',chunk=>{size+=chunk.length;if(size>4000000){response.destroy(new Error('模型响应过大。'));return;}chunks.push(chunk);});
      response.on('error',reject);response.on('end',()=>{const text=Buffer.concat(chunks).toString('utf8');resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,json:async()=>JSON.parse(text)});});
    });request.on('error',reject);request.end(body);
  });
}
