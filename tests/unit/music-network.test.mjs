import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { classifySmbSessions,listSmbConnections,parseNetErrorCode,scanWebDav,smbServerRoot,smbShareRoot,WebDavRangeBridge } from '../../apps/desktop/dist/main/music-network.js';

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

test('SMB UNC identity separates server and share roots',()=>{assert.equal(smbServerRoot('\\\\NAS\\Music\\HiRes'),'\\\\NAS');assert.equal(smbShareRoot('\\\\NAS\\Music\\HiRes'),'\\\\NAS\\Music');});
test('SMB numeric error parser recognizes 1219 even when surrounding localized bytes are not UTF-8',()=>{const raw=Buffer.concat([Buffer.from([0xc4,0xe3,0xba,0xc3,0x20]),Buffer.from('1219'),Buffer.from([0x20,0xb4,0xed,0xce,0xf3])]);assert.equal(parseNetErrorCode(raw),1219);});
test('SMB session classification reuses compatible credentials and rejects conflicting credentials on the same server',()=>{const sessions=[{server:'\\\\NAS',share:'Music',username:'HOME\\alice'},{server:'\\\\OTHER',share:'Docs',username:'HOME\\bob'}];assert.deepEqual(classifySmbSessions('\\\\NAS\\More',{username:'alice'},sessions),{server:'\\\\NAS',sameServer:[sessions[0]],compatible:true,conflict:false});assert.equal(classifySmbSessions('\\\\NAS\\More',{username:'bob'},sessions).conflict,true);assert.equal(classifySmbSessions('\\\\NEW\\Music',{username:'bob'},sessions).conflict,false);});
test('Windows SMB session discovery returns structured rows without localized text parsing',async()=>{const sessions=await listSmbConnections();assert.ok(Array.isArray(sessions));for(const row of sessions){assert.ok(row.server.startsWith('\\\\'));assert.equal(typeof row.share,'string');assert.equal(typeof row.username,'string');}});