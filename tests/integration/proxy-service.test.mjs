import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {ProxyService} from '../../services/proxy-service/dist/index.js';

async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;}
async function startedProxy(t){const proxy=new ProxyService();const descriptor=await proxy.start();t.after(()=>proxy.stop());return{proxy,descriptor};}

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
