import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {ProxyService} from '../../services/proxy-service/dist/index.js';

async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;}
async function startedProxy(t){const proxy=new ProxyService();const descriptor=await proxy.start();t.after(()=>proxy.stop());return{proxy,descriptor};}

const syntheticHeaders={authorization:'Bearer source-fixture',cookie:'fixture=value',referer:'https://fixture.invalid/','x-source-token':'fixture-secret','user-agent':'scope-test-player'};
async function sourceOrigins(t,respond){
 const bases={},seen=[];
 for(const name of ['a','b']){
  const server=http.createServer((request,response)=>{seen.push({origin:name,path:request.url,headers:{...request.headers}});respond(name,request,response,bases);});
  bases[name]=`http://127.0.0.1:${await listen(server)}`;t.after(()=>{server.closeAllConnections();server.close();});
 }
 return{bases,seen};
}
function assertCredentialScope(request,trusted){
 assert.equal(request.headers['user-agent'],syntheticHeaders['user-agent']);
 for(const name of ['authorization','cookie','referer','x-source-token'])assert.equal(request.headers[name],trusted?syntheticHeaders[name]:undefined,request.origin+request.path+' '+name);
}

test('proxy authenticates rewrites HLS and converts SRT subtitles',async t=>{
 let forwarded='';const upstream=http.createServer((req,res)=>{forwarded=String(req.headers.referer??'');if(req.url==='/master.m3u8'){res.setHeader('content-type','application/vnd.apple.mpegurl');res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nseg.ts');return;}if(req.url==='/sub.srt'){res.setHeader('content-type','application/x-subrip');res.end('1\n00:00:01,000 --> 00:00:02,000\nHello');return;}res.end('data');});
 const port=await listen(upstream);t.after(()=>upstream.close());const{proxy,descriptor}=await startedProxy(t);const target=`http://127.0.0.1:${port}/master.m3u8`;
 const unauthorized=await fetch(proxy.url(target));assert.equal(unauthorized.status,401);
 const response=await fetch(proxy.url(target,{Referer:'https://ref.test/'}),{headers:{Authorization:`Bearer ${descriptor.token}`}});const manifest=await response.text();
 assert.equal(response.status,200);assert.equal(forwarded,'https://ref.test/');assert.match(manifest,/\/proxy\?u=/);assert.match(manifest,/URI="http:\/\/127\.0\.0\.1:/);
 const subtitle=await fetch(proxy.subtitleUrl(`http://127.0.0.1:${port}/sub.srt`),{headers:{Authorization:`Bearer ${descriptor.token}`}});assert.match(await subtitle.text(),/^WEBVTT[\s\S]*00:00:01\.000/);
});

test('proxy preserves Range and If-Range and forwards partial responses',async t=>{
 let seenRange='',seenIfRange='';const upstream=http.createServer((req,res)=>{seenRange=String(req.headers.range??'');seenIfRange=String(req.headers['if-range']??'');if(seenRange==='bytes=2-4'){res.writeHead(206,{'content-type':'video/mp4','content-range':'bytes 2-4/10','accept-ranges':'bytes','content-length':'3'});res.end('234');return;}res.end('0123456789');});
 const port=await listen(upstream);t.after(()=>upstream.close());const{proxy,descriptor}=await startedProxy(t);
 const response=await fetch(proxy.url(`http://127.0.0.1:${port}/media.mp4`),{headers:{Authorization:`Bearer ${descriptor.token}`,Range:'bytes=2-4','If-Range':'"etag-v1"'}});
 assert.equal(seenRange,'bytes=2-4');assert.equal(seenIfRange,'"etag-v1"');assert.equal(response.status,206);assert.equal(response.headers.get('content-range'),'bytes 2-4/10');assert.equal(await response.text(),'234');
});

test('proxy resolves HLS relative URIs against the final redirected URL',async t=>{
 const upstream=http.createServer((req,res)=>{if(req.url==='/entry.m3u8'){res.writeHead(302,{Location:'/cdn/master.m3u8'});res.end();return;}if(req.url==='/cdn/master.m3u8'){res.setHeader('content-type','application/vnd.apple.mpegurl');res.end('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\nseg.ts');return;}res.writeHead(404);res.end();});
 const port=await listen(upstream);t.after(()=>upstream.close());const{proxy,descriptor}=await startedProxy(t);const response=await fetch(proxy.url(`http://127.0.0.1:${port}/entry.m3u8`),{headers:{Authorization:`Bearer ${descriptor.token}`}});const manifest=await response.text();
 const segmentLine=manifest.split(/\r?\n/).find(line=>line&&!line.startsWith('#')&&line.includes('/proxy?u='));assert.ok(segmentLine);const segmentTarget=new URL(segmentLine).searchParams.get('u');assert.equal(segmentTarget,`http://127.0.0.1:${port}/cdn/seg.ts`);
 const keyMatch=/URI="([^"]+)"/.exec(manifest);assert.ok(keyMatch);assert.equal(new URL(keyMatch[1]).searchParams.get('u'),`http://127.0.0.1:${port}/cdn/key.bin`);
});

test('proxy preserves HEAD semantics without downloading a body',async t=>{
 let method='';const upstream=http.createServer((req,res)=>{method=req.method??'';res.writeHead(200,{'content-type':'video/mp4','content-length':'10','accept-ranges':'bytes'});if(req.method!=='HEAD')res.end('0123456789');else res.end();});
 const port=await listen(upstream);t.after(()=>upstream.close());const{proxy,descriptor}=await startedProxy(t);const response=await fetch(proxy.url(`http://127.0.0.1:${port}/media.mp4`),{method:'HEAD',headers:{Authorization:`Bearer ${descriptor.token}`}});
 assert.equal(method,'HEAD');assert.equal(response.status,200);assert.equal(response.headers.get('content-length'),'10');assert.equal(await response.text(),'');
});

test('proxy aborts upstream streaming when the client disconnects',async t=>{
 let upstreamClosed=false;let timer;const upstream=http.createServer((req,res)=>{req.on('close',()=>{upstreamClosed=true;});res.writeHead(200,{'content-type':'video/mp4'});res.write(Buffer.alloc(64*1024));timer=setInterval(()=>res.write(Buffer.alloc(64*1024)),20);});
 const port=await listen(upstream);t.after(()=>{if(timer)clearInterval(timer);upstream.close();});const{proxy,descriptor}=await startedProxy(t);const target=new URL(proxy.url(`http://127.0.0.1:${port}/stream.mp4`));
 await new Promise((resolve,reject)=>{const req=http.get({hostname:'127.0.0.1',port:Number(target.port),path:target.pathname+target.search,headers:{Authorization:`Bearer ${descriptor.token}`}},res=>{res.once('data',()=>{req.destroy();resolve();});});req.once('error',error=>{if(error.code==='ECONNRESET')resolve();else reject(error);});});
 const deadline=Date.now()+2000;while(!upstreamClosed&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(upstreamClosed,true);
});

test('real TCP HLS keys, maps, variants and segments preserve same-origin authentication and strip cross-origin credentials',async t=>{
 const {bases,seen}=await sourceOrigins(t,(name,req,res,origins)=>{
  if(name==='a'&&['/master.m3u8','/init.mp4','/same.ts'].includes(req.url)&&req.headers.authorization!==syntheticHeaders.authorization){res.writeHead(401);res.end();return;}
  if(req.url==='/master.m3u8'){res.setHeader('content-type','application/vnd.apple.mpegurl');res.end(`#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${origins.b}/key.bin"\n#EXT-X-MAP:URI="init.mp4"\n${origins.b}/variant.m3u8\nsame.ts`);return;}
  if(req.url==='/variant.m3u8'){res.setHeader('content-type','application/vnd.apple.mpegurl');res.end(`#EXTM3U\ncdn.ts\n${origins.a}/returned.ts`);return;}
  res.end('fixture-media-bytes');
 });
 const {proxy,descriptor}=await startedProxy(t),headers={authorization:`Bearer ${descriptor.token}`};
 const response=await fetch(proxy.url(bases.a+'/master.m3u8',syntheticHeaders),{headers});assert.equal(response.status,200);
 const children=body=>[...body.matchAll(/URI="([^"]+)"/g)].map(match=>match[1]).concat(body.split('\n').filter(line=>line&&!line.startsWith('#')));
 const urls=children(await response.text());assert.equal(urls.length,4);
 for(const url of urls){const child=await fetch(url,{headers});assert.equal(child.status,200);const body=await child.text();if(child.headers.get('content-type')?.includes('mpegurl'))for(const nested of children(body)){const segment=await fetch(nested,{headers});assert.equal(segment.status,200);await segment.text();}}
 assert.equal(seen.length,7);
 for(const request of seen)assertCredentialScope(request,request.origin==='a'&&['/master.m3u8','/init.mp4','/same.ts'].includes(request.path));
 assert.ok(seen.some(request=>request.origin==='a'&&request.path==='/returned.ts'),'nested cross-origin playlist must not resurrect initial credentials on returning to the original origin');
});

test('real TCP redirect round trips never restore stripped credentials and resolve children against the final path',async t=>{
 const {bases,seen}=await sourceOrigins(t,(name,req,res,origins)=>{
  const location=req.url==='/entry'?'/same':req.url==='/same'?origins.b+'/return':req.url==='/return'?origins.a+'/final/master.m3u8':undefined;
  if(location){res.writeHead(307,{location});res.end();return;}
  if(req.url==='/final/master.m3u8'){res.setHeader('content-type','application/vnd.apple.mpegurl');res.end('#EXTM3U\nsegment.ts');return;}
  if(req.url==='/final/segment.ts'){res.end('fixture-segment');return;}
  res.writeHead(404);res.end();
 });
 const {proxy,descriptor}=await startedProxy(t),headers={authorization:`Bearer ${descriptor.token}`};
 const response=await fetch(proxy.url(bases.a+'/entry',syntheticHeaders),{headers});assert.equal(response.status,200);
 const child=(await response.text()).split('\n').find(line=>line&&!line.startsWith('#'));assert.ok(child);assert.equal(new URL(child).searchParams.get('u'),bases.a+'/final/segment.ts');
 const segment=await fetch(child,{headers});assert.equal(segment.status,200);assert.equal(await segment.text(),'fixture-segment');
 assert.equal(seen.length,5);for(const request of seen)assertCredentialScope(request,request.origin==='a'&&['/entry','/same'].includes(request.path));
});
