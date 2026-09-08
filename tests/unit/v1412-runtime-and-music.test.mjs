import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir,rm,writeFile} from 'node:fs/promises';
import {fork} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {classifyRuntimeFlavor,runtimeHint} from '../../services/source-engine/dist/runtime-classifier.js';
import {assertSafeDrpyUrl} from '../../services/source-engine/dist/drpy-engine-manager.js';
const text=rel=>readFile(new URL('../../'+rel,import.meta.url),'utf8');

test('v1.4.12 classifies drpy2 ESM by multiple signals',()=>{
 const code=`import './drpy-core-lite.min.js'; export default {init(){},home(){},category(){},detail(){},search(){},play(){}}`;
 const result=classifyRuntimeFlavor({endpoint:'https://example.com/drpy2.min.js',ext:'https://example.com/rule.js'},code);
 assert.equal(result.flavor,'drpy2-esm');assert.ok(result.score>=5);assert.ok(result.signals.includes('source:export-default'));
});
test('v1.4.12 blocks private drpy2 network targets',()=>{
 for(const url of ['http://127.0.0.1/a','http://169.254.169.254/latest','http://192.168.1.2/a'])assert.throws(()=>assertSafeDrpyUrl(url),/DRPY_REQ_BLOCKED/);
 assert.equal(assertSafeDrpyUrl('https://example.com/a').hostname,'example.com');
});
test('v1.4.12 drpy2 worker executes ESM and synchronous broker req without blocking parent',async()=>{
 const dir=path.join(os.tmpdir(),`fnd-drpy2-test-${randomUUID()}`);await mkdir(dir,{recursive:true});
 const entry='https://example.com/drpy2.js';
 const code=`const host={pdfh,pdfa,pd,joinUrl};export default {init(ext){this.ext=ext;this.rule={title:'Fixture'};return this},getRule(){return this.rule},home(){return {class:[{type_id:'1',type_name:host.pdfh('<b>Demo</b>','b&&Text')}],list:[]}},search(k){const r=req('https://example.com/api',{timeout:3000});return {list:[{vod_id:'1',vod_name:k+' '+r.content}]}}}`;
 const child=fork(new URL('../../services/drpy2-worker/dist/worker.js',import.meta.url),[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--experimental-vm-modules']});
 const ask=payload=>new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>reject(new Error('worker timeout')),10000);const on=m=>{if(m?.type==='broker.request'){const target=path.join(dir,`${m.id}.json`);void writeFile(target,JSON.stringify({result:{content:'OK',headers:{},code:200}}),'utf8');return;}if(m?.type==='response'&&m.id===id){clearTimeout(timer);child.off('message',on);m.error?reject(new Error(m.error)):resolve(m.result);}};child.on('message',on);child.send({...payload,id});});
 try{await ask({type:'init',sourceId:'test',entryUrl:entry,modules:{[entry]:code},ruleExt:'fixture-rule',bridgeDir:dir,profileId:'fixture-drpy2',hostAbiVersion:'fixture-host/2'});const home=await ask({type:'call',method:'home',args:[]});assert.equal(home.class[0].type_name,'Demo');const result=await ask({type:'call',method:'search',args:['needle']});assert.match(result.list[0].vod_name,/needle OK/);}finally{child.kill();await rm(dir,{recursive:true,force:true});}
});
test('v1.4.12 music progress accepts PlayerHost Windows path for file URL session',async()=>{
 const [session,identity]=await Promise.all([text('apps/desktop/src/main/playback-session-ipc.ts'),text('apps/desktop/src/main/media-identity.ts')]);assert.match(session,/sameMediaPath/);assert.match(identity,/fileURLToPath/);assert.match(identity,/toLocaleLowerCase\('en-US'\)/);
});
test('v1.4.12 lyrics are online-first and LRCLIB search ignores polluted album filter',async()=>{
 const service=await text('apps/desktop/src/main/music-service.ts'),online=await text('apps/desktop/src/main/music-online.ts');const fn=service.slice(service.indexOf('async function readLyrics'),service.indexOf('async function addNetworkSource'));assert.ok(fn.indexOf('findOnlineLyrics')<fn.indexOf('track.lyricsPath'));assert.match(online,/new URLSearchParams\(\{track_name:clean\.title,artist_name:clean\.artist\}\)/);assert.doesNotMatch(online,/artist_name:clean\.artist,album_name/);
});
test('v1.4.12 playback switching is latest-wins and live uses optimistic first route',async()=>{
 const main=await text('apps/desktop/src/main/index.ts'),preload=await text('apps/desktop/src/preload/index.cts');assert.match(main,/vodPlaybackController\?\.abort/);assert.match(main,/PLAYBACK_SUPERSEDED/);assert.match(preload,/const optimistic=await tryCandidate\(0\)/);assert.match(main,/live route superseded/);
});
test('v1.4.12 packages drpy2 worker and exposes the new version',async()=>{
 const root=JSON.parse(await text('package.json'));assert.equal(root.version,'1.4.12');assert.ok(root.build.files.includes('services/drpy2-worker/dist/**/*'));assert.match(root.scripts['build:packages'],/@free-new-desk\/drpy2-worker/);
});

test('v1.4.12 uses the supplied opaque icon across renderer window tray and installer wiring',async()=>{
  const [main,app,manifest,iconScript]=await Promise.all([
    text('apps/desktop/src/main/index.ts'),
    text('apps/desktop/src/renderer/App.vue'),
    text('package.json'),
    text('scripts/materialize-app-icons.mjs')
  ]);
  assert.match(main,/function appIconPath\(\)/);
  assert.match(main,/icon:appIconPath\(\)/);
  assert.match(main,/nativeImage\.createFromPath\(appIconPath\(\)\)/);
  assert.match(app,/import appIconUrl from '.\/assets\/app-icon\.png'/);
  assert.match(manifest,/assets\/app-icon\.ico/);
  assert.match(iconScript,/sizes=\[16,20,24,32,48,64,128,256\]/);
  assert.match(iconScript,/opaque multi-size ICO/);
  assert.match(iconScript,/without redrawing the supplied icon/);
});
test('v1.4.12 reproducibly prepares the pinned libmpv runtime before Windows packaging',async()=>{
  const [manifest,script,source]=await Promise.all([
    text('package.json'),
    text('scripts/ensure-mpv-runtime.mjs'),
    text('third_party/mpv/win-x64/SOURCE.txt')
  ]);
  assert.match(manifest,/"prepare:mpv": "node scripts\/ensure-mpv-runtime\.mjs"/);
  assert.match(manifest,/prepare:icons && npm run prepare:mpv && npm run build/);
  assert.match(script,/archive sha256/);
  assert.match(script,/dll sha256/);
  assert.match(script,/7zip-bin/);
  assert.match(source,/dll sha256: cb67e96c08bbcd0efd60949e7562f034f5dba2e0bc6838cb4161ee5636c33145/i);
});

test('v1.4.12 stages external runtime dependencies and isolates packaged smoke from repo node_modules',async()=>{
  const [stager,sourceEngineManifest,shimManifest,smoke,client]=await Promise.all([
    text('scripts/prepare-runtime-workspaces.mjs'),
    text('services/source-engine/package.json'),
    text('packages/catvod-runtime-shim/package.json'),
    text('scripts/test-packaged-app.ps1'),
    text('apps/desktop/src/main/source-engine-client.ts')
  ]);
  assert.match(sourceEngineManifest,/"es-module-lexer": "1\.7\.0"/);
  assert.match(shimManifest,/"cheerio": "1\.0\.0"/);
  assert.match(stager,/externalStaged/);assert.match(stager,/manifest\.dependencies/);assert.match(stager,/runtime dependency of/);
  assert.match(smoke,/free-new-desk-package-isolated-/);assert.match(smoke,/Copy-Item -Path \$sourcePackage/);
  assert.match(client,/stdio:\['ignore','ignore','pipe'\]/);assert.match(client,/Source Engine exited \(code \$\{code\}\)/);
});