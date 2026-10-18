import test from 'node:test';
import assert from 'node:assert/strict';
import {isPublicAddress,publicApiFetch} from '../lib/public-api-fetch.mjs';
import {PassThrough} from 'node:stream';

test('ordinary custom APIs cannot target internal, mapped, link-local or reserved addresses',async()=>{
  for(const ip of ['0.0.0.0','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.16.1.1','192.168.1.1','192.0.2.1','198.18.0.1','203.0.113.2','224.0.0.1','255.255.255.255','::','::1','::ffff:127.0.0.1','::ffff:8.8.8.8','fc00::1','fe80::1','ff02::1','2001:db8::1','64:ff9b::7f00:1'])assert.equal(isPublicAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(isPublicAddress(ip),true,ip);
  await assert.rejects(publicApiFetch('http://127.0.0.1:3211/api/config'),/HTTPS/);
  await assert.rejects(publicApiFetch('https://127.0.0.1/'),/内网|本机/);
  await assert.rejects(publicApiFetch('https://[::ffff:127.0.0.1]/'),/内网|本机/);
});
test('public HTTPS requests pin the validated DNS result and never follow redirects',async()=>{
  let lookups=0,requests=0;
  const dependencies={lookup:async()=>{lookups++;return [{address:lookups===1?'8.8.8.8':'127.0.0.1',family:4}];},request:(url,options,callback)=>{
    requests++;assert.equal(url.hostname,'api.example.test');assert.notEqual(options.rejectUnauthorized,false);options.lookup(url.hostname,{},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);});
    return {on(){return this;},end(){const response=new PassThrough();response.statusCode=302;callback(response);response.end('{}');}};
  }};
  const response=await publicApiFetch('https://api.example.test/v1/chat/completions',{body:'{}'},dependencies);assert.equal(response.ok,false);assert.equal(response.status,302);assert.equal(lookups,1);assert.equal(requests,1);assert.deepEqual(await response.json(),{});
});
