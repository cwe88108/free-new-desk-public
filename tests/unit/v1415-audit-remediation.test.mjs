import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const importBuilt=relative=>import(pathToFileURL(path.join(root,relative)).href+`?v=${Date.now()}-${Math.random()}`);

test('v1.4.15 projects V2 media and parser candidates without losing hints',async()=>{
 const{projectPlaybackDescriptorV2}=await importBuilt('apps/desktop/dist/main/playback-resolver.js');
 const direct=projectPlaybackDescriptorV2({schemaVersion:2,sourceId:'s',configRevision:'r',originProfileId:'p',rawHints:{},resolutionIntent:'direct',candidates:[{id:'m',target:{kind:'media',url:'https://media.test/a.mp4'},seekability:'seekable',headers:{Referer:'https://ref.test/'}}],subtitles:[{url:'https://media.test/a.vtt',name:'中文'}],drmStatus:'none'});
 assert.equal(direct.resolved.url,'https://media.test/a.mp4');assert.equal(direct.resolved.parse,false);assert.equal(direct.resolved.headers.Referer,'https://ref.test/');assert.equal(direct.resolved.subtitles[0].name,'中文');
 const parser=projectPlaybackDescriptorV2({schemaVersion:2,sourceId:'s',configRevision:'r',originProfileId:'p',rawHints:{playUrl:'https://jx.test/?url='},resolutionIntent:'parser',candidates:[{id:'p',target:{kind:'parser-input',value:'opaque-episode',parserIds:[]},seekability:'unknown'}]});
 assert.equal(parser.resolved.url,'opaque-episode');assert.equal(parser.resolved.parse,true);assert.equal(parser.playUrl,'https://jx.test/?url=');
});

test('v1.4.15 rejects opaque V2 runtime targets deterministically',async()=>{
 const{projectPlaybackDescriptorV2}=await importBuilt('apps/desktop/dist/main/playback-resolver.js');
 assert.throws(()=>projectPlaybackDescriptorV2({schemaVersion:2,sourceId:'s',configRevision:'r',originProfileId:'p',rawHints:{},resolutionIntent:'runtime-proxy',candidates:[{id:'x',target:{kind:'runtime-proxy',callbackHandle:'opaque'},seekability:'unknown'}]}),/PLAY_V2_RUNTIME_TARGET_UNSUPPORTED/);
});

test('v1.4.15 runtime lease follows the authoritative player session',async()=>{
 const{SourceRuntimeLeaseTracker}=await importBuilt('apps/desktop/dist/main/source-runtime-lease.js');const released=[];const tracker=new SourceRuntimeLeaseTracker(async id=>{released.push(id);});
 await tracker.adopt('lease-1','request-1');await tracker.observe({generation:1,sessionId:'s1',requestId:'request-1',domain:'vod',status:'playing',updatedAt:1});assert.deepEqual(released,[]);
 await tracker.observe({generation:2,sessionId:'s2',requestId:'request-2',domain:'live',status:'requested',updatedAt:2});assert.deepEqual(released,['lease-1']);
 await tracker.adopt('lease-2','request-2');await tracker.observe({generation:2,sessionId:'s2',requestId:'request-2',domain:'live',status:'ended',updatedAt:3});assert.deepEqual(released,['lease-1','lease-2']);
});
test('v1.4.15 desktop VOD main path consumes playV2 and releases pending leases',async()=>{
 const source=await readFile(path.join(root,'apps/desktop/src/main/index.ts'),'utf8');const start=source.indexOf('async function playResolved('),end=source.indexOf('function liveUrls(',start);assert.ok(start>0&&end>start);const body=source.slice(start,end);
 assert.match(body,/sourceEngine\.playV2\(/);assert.doesNotMatch(body,/sourceEngine\.play\(/);assert.match(body,/projectPlaybackDescriptorV2\(/);assert.match(body,/sourceRuntimeLeases\.adopt\(/);assert.match(body,/finally\{await releasePendingLease\(\)/);
});

test('v1.4.15 source audit uses V2 and labels interface-only evidence',async()=>{
 const source=await readFile(path.join(root,'services/source-engine/src/index.ts'),'utf8');assert.match(source,/getPlayV2\(sourceId,episode\.flag,episode\.id\)/);assert.match(source,/scope:'source-interface'/);assert.match(source,/本审计未调用 PlayerHost/);
});

test('v1.4.15 compatibility audit separates interface from actual playback evidence',async()=>{
 const script=await readFile(path.join(root,'scripts/source-compat-e2e.mjs'),'utf8');
 assert.match(script,/sourceInterfaceOk/);assert.match(script,/playerValidated:false/);assert.match(script,/missing\(result,'detail'/);assert.match(script,/missing\(result,'playV2'/);assert.match(script,/Actual playback requires PlayerHost validation/);
});
