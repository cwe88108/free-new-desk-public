import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {collectSurfaceTiming} from '../../scripts/collect-surface-timing.mjs';
const cli=fileURLToPath(new URL('../../scripts/collect-surface-timing.mjs',import.meta.url));
const time='2026-11-03T10:13:20.094Z';
const samples=['surfaceHideMs','surfaceReleaseQueueMs','surfaceReleaseIpcMs','surfaceHostReadyWaitMs','surfacePipeConnectMs','surfacePipeRoundTripMs','surfaceNativeCommandLockMs','surfaceNativeSurfaceLockMs','surfaceNativeApplyMs','surfaceNativeTotalMs'].map((metric,index)=>({time,metric,value:100+index}));
async function fixture(run){const dir=await mkdtemp(path.join(tmpdir(),'fnd-trace-'));try{const sourceDir=path.join(dir,'source'),outputDir=path.join(dir,'output');await mkdir(path.join(sourceDir,'logs'),{recursive:true});await run({sourceDir,outputDir,prefix:'scale-1-25-normal',flushed:true,file:path.join(sourceDir,'logs','surface-timing.jsonl')});}finally{await rm(dir,{recursive:true,force:true});}}

test('real collector CLI preserves UTC strings and produces verified evidence for all four DPI prefixes',async()=>fixture(async options=>{
  await writeFile(options.file,samples.map(s=>JSON.stringify(s)).join('\r\n'));
  for(const prefix of ['scale-1-normal','scale-1-25-normal','scale-1-5-high-contrast','scale-2-high-contrast']){
    const child=spawnSync(process.execPath,[cli,options.sourceDir,options.outputDir,prefix,'true'],{encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
    const report=JSON.parse(await readFile(path.join(options.outputDir,prefix+'-surface-evidence.json'),'utf8'));
    const bytes=await readFile(path.join(options.outputDir,prefix+'-surface-timing.jsonl'));
    assert.equal(report.accepted,samples.length);assert.equal(report.rejected,0);assert.equal(report.status,'complete');
    assert.equal(report.outputBytes,bytes.length);assert.equal(report.sha256,createHash('sha256').update(bytes).digest('hex'));
    assert.equal(JSON.parse(bytes.toString().split('\n')[0]).time,time);
  }
}));

test('collector rejects malformed and sensitive fields without echoing input into evidence',async()=>fixture(async options=>{
  const valid=samples.map(s=>({...s,url:'https://private.invalid/?token=secret',authorization:'secret'}));
  const invalid=[{time:'secret',metric:'surfaceHideMs',value:1},{time,metric:'source-url-secret',value:1},{time,metric:'surfaceHideMs',value:'secret'},{time,metric:'surfaceHideMs',value:-1},{time,metric:'surfaceHideMs',value:130000}];
  await writeFile(options.file,[...valid,...invalid].map(s=>JSON.stringify(s)).join('\n')+'\n{"incomplete":');
  const {report,lines}=await collectSurfaceTiming(options);
  assert.equal(report.accepted,samples.length);assert.equal(report.rejected,6);assert.equal(report.status,'partial');
  assert.doesNotMatch(JSON.stringify(report)+lines.join('\n'),/secret|private|authorization|url/);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])),['time','metric','value']);
}));

test('flush ACK without records or required timings is partial, reported, and never a silent success',async()=>fixture(async options=>{
  await mkdir(options.outputDir,{recursive:true});
  await writeFile(path.join(options.outputDir,options.prefix+'-surface-timing.jsonl'),'stale previous run');
  const child=spawnSync(process.execPath,[cli,options.sourceDir,options.outputDir,options.prefix,'true'],{encoding:'utf8'});
  assert.equal(child.status,1);
  const report=JSON.parse(await readFile(path.join(options.outputDir,options.prefix+'-surface-evidence.json'),'utf8'));
  assert.equal(report.flushAcknowledged,true);assert.equal(report.accepted,0);assert.equal(report.status,'partial');
  await assert.rejects(stat(path.join(options.outputDir,options.prefix+'-surface-timing.jsonl')),/ENOENT/);
  await writeFile(options.file,JSON.stringify({time,metric:'surfaceTraceFlushRequested',value:1}));
  const missing=await collectSurfaceTiming(options);assert.equal(missing.report.status,'partial');assert.equal(missing.report.missingMetrics.length,samples.length);
}));

const pwsh=spawnSync('pwsh',['-NoProfile','-Command','$PSVersionTable.PSVersion.ToString()'],{encoding:'utf8'}).status===0;
test('actual PowerShell finally invocation writes ISO timing evidence',{skip:pwsh?false:'PowerShell unavailable; this regression runs on Windows CI'},async()=>fixture(async options=>{
  await writeFile(options.file,samples.map(s=>JSON.stringify(s)).join('\n'));
  await writeFile(path.join(options.sourceDir,'logs','performance-runtime.json'),JSON.stringify({schemaVersion:1,appVersion:'1.5.6',workload:'packaged-ui-smoke-v1',generatedAt:time,durationMs:30000,counters:{playbackStatsIpcCalls:20,playerHostStatsQueryCalls:18},uiMetrics:{navigationMs:{count:12,p95:20},rendererFrameP95Ms:{count:1,p95:16.7}}}));
  const script=await readFile(new URL('../../scripts/test-packaged-ui.ps1',import.meta.url),'utf8');
  const invocation=script.slice(script.indexOf('  $previousExitCode = $LASTEXITCODE'),script.indexOf('  Write-Host "Smoke data retained'));
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  const command=`$collector=${quote(cli)}; $smokeDir=${quote(options.sourceDir)}; $captureDir=${quote(options.outputDir)}; $capturePrefix=${quote(options.prefix)}; $flushAcknowledged=$true; $LASTEXITCODE=0;\n${invocation}`;
  const result=spawnSync('pwsh',['-NoProfile','-Command',command],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/incomplete or collection failed/);
  const report=JSON.parse(await readFile(path.join(options.outputDir,options.prefix+'-surface-evidence.json'),'utf8'));
  assert.equal(report.accepted,samples.length);assert.equal(report.status,'complete');
  const performance=JSON.parse(await readFile(path.join(options.outputDir,options.prefix+'-performance.json'),'utf8'));
  assert.equal(performance.counters.playbackStatsIpcCalls,20);
}));

test('a collection filesystem failure invalidates only the previous dedicated evidence',async()=>fixture(async options=>{
  await mkdir(options.outputDir,{recursive:true});
  const reportPath=path.join(options.outputDir,options.prefix+'-surface-evidence.json');
  const timingPath=path.join(options.outputDir,options.prefix+'-surface-timing.jsonl');
  const unrelated=path.join(options.outputDir,'keep-user-file.txt');
  await writeFile(reportPath,JSON.stringify({status:'complete'}));await writeFile(timingPath,'old successful evidence');await writeFile(unrelated,'keep');
  const notDirectory=path.join(options.sourceDir,'not-a-directory');await writeFile(notDirectory,'fixture');
  await assert.rejects(collectSurfaceTiming({...options,sourceDir:notDirectory}));
  assert.equal(JSON.parse(await readFile(reportPath,'utf8')).status,'failed');
  await assert.rejects(stat(timingPath),/ENOENT/);assert.equal(await readFile(unrelated,'utf8'),'keep');
  // Refuse to recursively remove an unexpected directory at a dedicated filename.
  await mkdir(timingPath);await writeFile(path.join(timingPath,'keep.txt'),'keep');
  await assert.rejects(collectSurfaceTiming(options));
  assert.equal(JSON.parse(await readFile(reportPath,'utf8')).status,'failed');
  assert.equal(await readFile(path.join(timingPath,'keep.txt'),'utf8'),'keep');
}));
