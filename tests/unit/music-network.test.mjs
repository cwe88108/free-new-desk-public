import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { scanWebDav,WebDavRangeBridge } from '../../apps/desktop/dist/main/music-network.js';
import { SmbError,smbShareRoot } from '../../apps/desktop/dist/main/smb-session-manager.js';

async function listen(handler){const server=createServer(handler);await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();if(!address||typeof address==='string')throw new Error('no test port');return{server,origin:`http://127.0.0.1:${address.port}`};}
function close(server){return new Promise(resolve=>server.close(resolve));}

test('WebDAV scanner walks collections and keeps remote metadata',async()=>{
  const {server,origin}=await listen((req,res)=>{
    if(req.method!=='PROPFIND'){res.writeHead(405).end();return;}
    const pathname=new URL(req.url,origin).pathname;
    res.statusCode=207;res.setHeader('Content-Type','application/xml');
    if(pathname==='/dav/')res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/dav/Album/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/private/escape.flac</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>999</d:getcontentlength></d:prop></d:propstat></d:response></d:multistatus>`);
    else res.end(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/Album/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/dav/Album/Artist%20-%20Song.flac</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12345</d:getcontentlength><d:getetag>\"abc\"</d:getetag><d:getlastmodified>Sun, 06 Sep 2026 10:00:00 GMT</d:getlastmodified></d:prop></d:propstat></d:response></d:multistatus>`);
  });
  try{const result=await scanWebDav(`${origin}/dav/`,undefined,new AbortController().signal,50,value=>value.endsWith('.flac'));assert.equal(result.length,1);assert.equal(result[0].relativePath,'Album/Artist - Song.flac');assert.equal(result[0].size,12345);assert.equal(result[0].etag,'"abc"');assert.ok(!result.some(item=>item.url.includes('/private/')));}finally{await close(server);}
});

test('WebDAV scanner honors an already-aborted signal',async()=>{const controller=new AbortController();controller.abort(new Error('stop'));await assert.rejects(()=>scanWebDav('http://127.0.0.1:9/dav/',undefined,controller.signal,1,()=>true),/stop/);});

test('WebDAV range bridge forwards authorization and byte ranges without exposing credentials in URL',async()=>{
  let authorization='',range='';const body=Buffer.from('0123456789');
  const {server,origin}=await listen((req,res)=>{authorization=String(req.headers.authorization??'');range=String(req.headers.range??'');const match=/bytes=(\d+)-(\d*)/.exec(range);if(match){const start=Number(match[1]),end=match[2]?Number(match[2]):body.length-1,chunk=body.subarray(start,end+1);res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${body.length}`);res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Length',String(chunk.length));res.end(chunk);}else{res.setHeader('Content-Length',String(body.length));res.end(body);}});
  const bridge=new WebDavRangeBridge();
  try{const local=await bridge.urlFor(`${origin}/song.flac`,{username:'alice',password:'secret'});assert.ok(local.startsWith('http://127.0.0.1:'));assert.ok(!local.includes('alice'));assert.ok(!local.includes('secret'));const response=await fetch(local,{headers:{Range:'bytes=2-5'}});assert.equal(response.status,206);assert.equal(await response.text(),'2345');assert.equal(range,'bytes=2-5');assert.equal(authorization,`Basic ${Buffer.from('alice:secret').toString('base64')}`);}finally{await bridge.close();await close(server);}
});

test('SMB UNC identity extracts the share root and rejects device paths',()=>{
  assert.equal(smbShareRoot(String.raw`\\NAS\Music\HiRes`),String.raw`\\NAS\Music`);
  assert.equal(smbShareRoot(String.raw`\\?\C:\Music`),undefined);
});
test('SMB numeric errors map to stable application error codes',()=>{
  assert.match(new SmbError(1219).message,/SMB_CREDENTIAL_CONFLICT.*1219/);
  assert.match(new SmbError(1326).message,/SMB_LOGON_FAILED.*1326/);
});
