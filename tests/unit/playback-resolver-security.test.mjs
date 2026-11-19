import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {RequestBroker} from '../../packages/source-sdk/dist/index.js';
import {PlaybackResolver} from '../../apps/desktop/dist/main/playback-resolver.js';

const credentials={Cookie:'fake-session',Authorization:'Bearer fake-token',Referer:'https://private.example/',Origin:'https://private.example','Proxy-Authorization':'fake-proxy','User-Agent':'test-player'};
const sensitive=['cookie','authorization','referer','origin','proxy-authorization'];
const input=url=>({sourceId:'resolver-security',sourceKind:'cms',flag:'',resolved:{url},sourceHeaders:credentials});
const noSecrets=headers=>{for(const key of sensitive)assert.equal(headers[key],undefined,key);};
async function server(t,handler){
  const instance=createServer(handler);await new Promise(resolve=>instance.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{instance.close(resolve);instance.closeAllConnections();}));
  return `http://127.0.0.1:${instance.address().port}`;
}
const neverSniff={resolve:async()=>{throw new Error('unexpected sniff');}};

test('sniff probe accepts media headers when the server rejects HEAD and ignores Range',async t=>{
  const methods=[];
  const endpoint=await server(t,(req,res)=>{
    if(req.url==='/page'){
      res.writeHead(200,{'Content-Type':'text/html'}).end();
      return;
    }
    methods.push([req.method,req.headers.range]);
    if(req.method==='HEAD')res.writeHead(405).end();
    else res.writeHead(200,{'Content-Type':'video/mp4','Content-Length':'10485760'}).flushHeaders();
  });
  const result=await new PlaybackResolver(new RequestBroker(),{
    resolve:async()=>({url:`${endpoint}/video.mp4`}),
  }).resolve(input(`${endpoint}/page`));
  assert.equal(result.url,`${endpoint}/video.mp4`);
  assert.equal(result.mode,'sniff');
  assert.equal(result.httpStatus,200);
  assert.deepEqual(methods,[['HEAD',undefined],['GET','bytes=0-65535']]);
});

test('resolver preserves same-origin credentials but never revives them after A → B → A',async t=>{
  const seen=[];let a;
  const b=await server(t,(req,res)=>{seen.push(req.headers);res.writeHead(307,{Location:`${a}/final.mp4`});res.end();});
  a=await server(t,(req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{Location:`${b}/bounce`});}else{if(req.url==='/final.mp4')seen.push(req.headers);res.writeHead(200,{'Content-Type':'video/mp4'});}res.end();});
  const resolver=new PlaybackResolver(new RequestBroker(),neverSniff);
  const same=await resolver.resolve(input(`${a}/same.mp4`));assert.equal(same.headers.authorization,credentials.Authorization);
  const redirected=await resolver.resolve(input(`${a}/redirect`));assert.equal(redirected.url,`${a}/final.mp4`);noSecrets(redirected.headers);seen.forEach(noSecrets);
  assert.equal(redirected.headers['user-agent'],'test-player');
});

test('HEAD failure, range fallback and sniff do not refill stripped/default credentials',async t=>{
  const seen=[];const b=await server(t,(req,res)=>{seen.push(req.headers);res.writeHead(req.method==='HEAD'?405:200,{'Content-Type':'text/html'});res.end('page');});
  const a=await server(t,(req,res)=>{res.writeHead(302,{Location:`${b}/page`});res.end();});
  const broker=new RequestBroker();broker.setDefaultHeaders('resolver-security',credentials);
  let sniffHeaders;const resolver=new PlaybackResolver(broker,{resolve:async(_source,url,headers)=>{assert.equal(url,`${b}/page`);sniffHeaders=headers;throw new Error('sniff reached');}});
  await assert.rejects(resolver.resolve(input(`${a}/start`)),/sniff reached/);noSecrets(sniffHeaders);seen.forEach(noSecrets);
});

test('sniff candidate keeps observed target headers, not inherited source credentials',async t=>{
  let received;const b=await server(t,(req,res)=>{received=req.headers;res.writeHead(200,{'Content-Type':'video/mp4'});res.end();});
  const a=await server(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end();});
  const resolver=new PlaybackResolver(new RequestBroker(),{resolve:async()=>({url:`${b}/media.mp4`,headers:{'User-Agent':'observed-agent'}})});
  const result=await resolver.resolve(input(`${a}/page`));noSecrets(received);noSecrets(result.headers);assert.equal(result.headers['user-agent'],'observed-agent');
});

test('JSON parser and final media are separately scoped and the media is probed',async t=>{
  const seen=[];let b;const a=await server(t,(req,res)=>{seen.push(req.headers);res.writeHead(200,{'Content-Type':'video/mp4'});res.end();});
  b=await server(t,(req,res)=>{seen.push(req.headers);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({url:`${a}/final.mp4`}));});
  const broker=new RequestBroker();broker.setDefaultHeaders('resolver-security',credentials);
  const result=await new PlaybackResolver(broker,neverSniff).resolve({...input(`${a}/original`),playUrl:`json:${b}/parse?url=`});
  assert.equal(result.mode,'parser');assert.equal(result.contentType,'video/mp4');assert.equal(seen.length,2);seen.forEach(noSecrets);noSecrets(result.headers);
});

test('parser rejects local/UNC/custom protocol and embedded-credential URLs before media requests',async t=>{
  for(const url of ['file:///etc/passwd','\\\\server\\share\\media.mp4','http://user:secret@example.com/video.mp4','data:video/mp4;base64,AA==','rtsp://example.com/video','not-a-url']){
    let requests=0;const endpoint=await server(t,(_req,res)=>{requests++;res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({url}));});
    await assert.rejects(new PlaybackResolver(new RequestBroker(),neverSniff).resolve({...input(`${endpoint}/original`),playUrl:`json:${endpoint}/parse?url=`}),/PLAY_DIRECT_INVALID/);
    assert.equal(requests,1);
  }
});

test('parser rejects successful HTML media targets and invalid header values',async t=>{
  for(const headers of [undefined,{Authorization:{nested:'invalid'}}]){
    let endpoint;endpoint=await server(t,(req,res)=>{res.writeHead(200,{'Content-Type':req.url.startsWith('/parse')?'application/json':'text/html'});res.end(req.url.startsWith('/parse')?JSON.stringify({url:`${endpoint}/page`,headers}):'<html>not media</html>');});
    await assert.rejects(new PlaybackResolver(new RequestBroker(),neverSniff).resolve({...input(`${endpoint}/original`),playUrl:`json:${endpoint}/parse?url=`}),/PLAY_PARSER_FAILED/);
  }
});

test('parser-provided target credentials are stripped on a later media redirect',async t=>{
  let received;const b=await server(t,(req,res)=>{received=req.headers;res.writeHead(200,{'Content-Type':'video/mp4'});res.end();});
  let a;a=await server(t,(req,res)=>{
    if(req.url.startsWith('/parse')){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({url:`${a}/media`,headers:credentials}));}
    else{assert.equal(req.headers.authorization,credentials.Authorization);res.writeHead(307,{Location:`${b}/final.mp4`});res.end();}
  });
  const result=await new PlaybackResolver(new RequestBroker(),neverSniff).resolve({...input(`${a}/original`),playUrl:`json:${a}/parse?url=`});
  noSecrets(received);noSecrets(result.headers);
});

test('HTML parser entry receives no original-origin credentials',async t=>{
  const endpoint=await server(t,(_req,res)=>{res.writeHead(200,{'Content-Type':'video/mp4'});res.end();});
  const resolver=new PlaybackResolver(new RequestBroker(),{resolve:async(_source,url,headers)=>{assert.ok(url.startsWith(`${endpoint}/parse`));noSecrets(headers);return{url:`${endpoint}/media.mp4`};}});
  const result=await resolver.resolve({...input('https://source.example/original'),playUrl:`${endpoint}/parse?url=`});
  noSecrets(result.headers);
});

test('HEAD fallback starts at final target instead of replaying an authenticated source with stripped headers',async t=>{
  const targetMethods=[];const b=await server(t,(req,res)=>{
    targetMethods.push(req.method);noSecrets(req.headers);
    res.writeHead(req.method==='HEAD'?405:200,{'Content-Type':req.method==='HEAD'?'text/html':'video/mp4'});res.end();
  });
  const sourceMethods=[];const a=await server(t,(req,res)=>{
    sourceMethods.push(req.method);
    if(req.headers.authorization!==credentials.Authorization){res.writeHead(401,{'Content-Type':'text/html'});res.end();return;}
    res.writeHead(302,{Location:`${b}/media.mp4`});res.end();
  });
  const result=await new PlaybackResolver(new RequestBroker(),neverSniff).resolve(input(`${a}/authenticated`));
  assert.equal(result.url,`${b}/media.mp4`);assert.equal(result.mode,'direct');noSecrets(result.headers);
  assert.deepEqual(sourceMethods,['HEAD']);assert.deepEqual(targetMethods,['HEAD','GET']);assert.equal(result.headers.range,undefined);
});

test('player failure fallback uses only already-scoped resolution headers',async t=>{
  const {readFile}=await import('node:fs/promises');
  const main=await readFile(new URL('../../apps/desktop/src/main/index.ts',import.meta.url),'utf8');
  const fallback=main.slice(main.indexOf('const forceFallback='),main.indexOf('lastPlaybackDiagnostic={checkedAt:',main.indexOf('const forceFallback=')));
  assert.match(fallback,/resolved:\{url:resolution.url,headers:resolution.headers,parse:true\}/);
  assert.doesNotMatch(fallback,/sourceHeaders:source.headers|\.\.\.resolved/);
  const received=[];const b=await server(t,(req,res)=>{received.push(req.headers);res.writeHead(200,{'Content-Type':'video/mp4'});res.end();});
  const a=await server(t,(_req,res)=>{res.writeHead(302,{Location:`${b}/media.mp4`});res.end();});
  const resolver=new PlaybackResolver(new RequestBroker(),{resolve:async(_source,url,headers)=>{noSecrets(headers);return{url};}});
  const direct=await resolver.resolve(input(`${a}/original`));
  const retried=await resolver.resolve({sourceId:'resolver-security',sourceKind:'cms',flag:'',resolved:{url:direct.url,headers:direct.headers,parse:true},forceSniff:true});
  noSecrets(retried.headers);received.forEach(noSecrets);
});

test('HEAD network failure keeps its last validated redirect target for GET fallback',async t=>{
  const methods=[];const b=await server(t,(req,res)=>{
    methods.push(req.method);noSecrets(req.headers);
    if(req.method==='HEAD'){res.destroy();return;}
    res.writeHead(200,{'Content-Type':'video/mp4'});res.end();
  });
  let sourceRequests=0;const a=await server(t,(req,res)=>{
    sourceRequests++;assert.equal(req.headers.authorization,credentials.Authorization);
    res.writeHead(302,{Location:`${b}/media.mp4`});res.end();
  });
  const result=await new PlaybackResolver(new RequestBroker(),neverSniff).resolve(input(`${a}/authenticated`));
  assert.equal(result.url,`${b}/media.mp4`);assert.equal(sourceRequests,1);assert.deepEqual(methods,['HEAD','GET']);noSecrets(result.headers);
});
