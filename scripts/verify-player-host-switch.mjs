import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const hostExe = process.env.FND_HOST_EXE ?? path.join(root, 'native', 'player-host', 'build', 'Release', 'player-host.exe');

function makeWav(seconds, sampleRate = 8000) {
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((i / sampleRate) * 2 * Math.PI * 440) * 0.05 * 32767);
    buffer.writeInt16LE(value, 44 + i * 2);
  }
  return buffer;
}

async function connectPipe(pipeName, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.connect(pipeName);
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }
  throw new Error('pipe connect timeout');
}

function createClient(socket) {
  let buffer = '';
  const pending = new Map();
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    }
  });
  let sequence = 0;
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = `v${++sequence}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timeout`));
    }, 12000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    socket.write(`${JSON.stringify({ id, method, ...params })}\n`);
  });
}

async function sampleUntilFresh(client, expectedDuration, budgetMs = 5000) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  let samples = 0;
  let pendingErrors = 0;
  while (Date.now() < deadline) {
    try {
      const reply = await client('player.query', { query: 'stats' });
      if (reply.error) {
        pendingErrors += 1;
      } else {
        const stats = reply.result;
        last = stats;
        samples += 1;
        if (stats.sampleValid === true && Number(stats.duration) > 0) {
          return { ok: Math.abs(Number(stats.duration) - expectedDuration) < 1, stats, samples, pendingErrors, elapsed: budgetMs - (deadline - Date.now()) };
        }
      }
    } catch {
      pendingErrors += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { ok: false, stats: last, samples, pendingErrors, elapsed: budgetMs };
}

const work = await mkdtemp(path.join(os.tmpdir(), 'fnd-host-verify-'));
const fileA = path.join(work, 'a-3s.wav');
const fileB = path.join(work, 'b-5s.wav');
const fileC = path.join(work, 'c-7s.wav');
await writeFile(fileA, makeWav(3));
await writeFile(fileB, makeWav(5));
await writeFile(fileC, makeWav(7));

const pipeName = `\\\\.\\pipe\\fnd-verify-${randomUUID()}`;
const parentHwnd = process.env.FND_VERIFY_PARENT_HWND;
if (parentHwnd && !/^\d+$/.test(parentHwnd)) throw new Error('Invalid test parent window handle');
const child = spawn(hostExe, ['--pipe', pipeName, '--parent-pid', String(process.pid), ...(parentHwnd ? ['--parent-hwnd', parentHwnd] : []), '--test-audio-output', 'null'], {
  cwd: path.dirname(hostExe),
  stdio: 'ignore',
  windowsHide: true,
});

const results = [];
let socket;
try {
  socket = await connectPipe(pipeName);
  const client = createClient(socket);
  const ping = await client('player.ping');
  results.push({ step: 'ping', ok: !ping.error, detail: ping.error ?? 'ok' });
  if (ping.error) throw new Error(`host not ready: ${ping.error}`);

  // mpv expands a playlist with END_FILE(redirect), then START_FILE for its child.
  const inner = path.join(work, 'inner.m3u');
  const outer = path.join(work, 'outer.m3u');
  await writeFile(inner, `#EXTM3U\n${pathToFileURL(fileB).href}\n`);
  await writeFile(outer, `#EXTM3U\n${pathToFileURL(inner).href}\n`);
  const playlistLoad = await client('player.load', { url: pathToFileURL(outer).href, profile: 'live' });
  const playlistSample = await sampleUntilFresh(client, 5);
  const playlistState = await client('player.query', { query: 'load-status' });
  results.push({step:'nested playlist redirects keep the original load and reach decoded media',ok:!playlistLoad.error&&playlistSample.ok&&playlistState.result?.status==='loaded'&&playlistSample.stats?.loadId===playlistLoad.result?.loadId,detail:{state:playlistState.result,sample:playlistSample.stats}});
  const broken = path.join(work, 'broken.m3u');
  await writeFile(broken, `#EXTM3U\n${pathToFileURL(path.join(work, 'missing.wav')).href}\n`);
  await client('player.load', { url: pathToFileURL(broken).href, profile: 'live' });
  let brokenState;
  const brokenDeadline = Date.now() + 3000;
  do {
    brokenState = await client('player.query', { query: 'load-status' });
    if (['failed', 'ended'].includes(brokenState.result?.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < brokenDeadline);
  results.push({step:'playlist child failure still terminates loading',ok:['failed','ended'].includes(brokenState.result?.status),detail:brokenState.result});
  await client('player.load', { url: pathToFileURL(outer).href, profile: 'live' });

  // ── A：首次加载 3 秒
  const loadA = await client('player.load', { url: pathToFileURL(fileA).href, profile: 'vod' });
  results.push({ step: 'load A(3s)', ok: !loadA.error && Boolean(loadA.result?.loadId), detail: loadA.error ?? loadA.result?.loadId });
  const sampleA = await sampleUntilFresh(client, 3);
  results.push({ step: 'sample A fresh', ok: sampleA.ok, detail: `duration=${sampleA.stats?.duration} valid=${sampleA.stats?.sampleValid} attempts=${sampleA.samples} pending=${sampleA.pendingErrors}` });
  const surface=sampleA.stats?.videoSurface;
  results.push({step:'parked native window reports display diagnostics without claiming a presented frame',ok:Boolean(surface&&surface.mode==='embedded'&&surface.requestedVisible===false&&surface.windowVisible===false&&typeof surface.windowExists==='boolean'&&typeof surface.parentMatches==='boolean'&&Number.isFinite(surface.width)&&Number.isFinite(surface.height)&&!('presented' in surface)),detail:surface});

  // ── B：切换到 5 秒（模拟点播切换）
  const loadB = await client('player.load', { url: pathToFileURL(fileB).href, profile: 'vod' });
  results.push({ step: 'load B(5s) switch', ok: !loadB.error && Boolean(loadB.result?.loadId), detail: loadB.error ?? loadB.result?.loadId });
  const sampleB = await sampleUntilFresh(client, 5);
  results.push({ step: 'sample B fresh after switch', ok: sampleB.ok, detail: `duration=${sampleB.stats?.duration} valid=${sampleB.stats?.sampleValid} attempts=${sampleB.samples} pending=${sampleB.pendingErrors}` });

  // ── C：快速连续切换（60ms 内两次 replace），验证竞态
  await client('player.load', { url: pathToFileURL(fileA).href, profile: 'vod' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const loadC = await client('player.load', { url: pathToFileURL(fileC).href, profile: 'vod' });
  results.push({ step: 'load C(7s) rapid switch', ok: !loadC.error && Boolean(loadC.result?.loadId), detail: loadC.error ?? loadC.result?.loadId });
  const sampleC = await sampleUntilFresh(client, 7, 6000);
  results.push({ step: 'sample C fresh after rapid switch', ok: sampleC.ok, detail: `duration=${sampleC.stats?.duration} valid=${sampleC.stats?.sampleValid} loadId=${sampleC.stats?.loadId} attempts=${sampleC.samples} pending=${sampleC.pendingErrors}` });
  const pausedLoad=await client('player.load',{url:pathToFileURL(fileC).href,profile:'vod',sessionGeneration:10,paused:true,pauseRevision:0});
  const pausedSample=await sampleUntilFresh(client,7);
  results.push({step:'paused intent loads without autoplay',ok:!pausedLoad.error&&pausedSample.ok&&pausedSample.stats.paused===true&&pausedSample.stats.position<0.5,detail:pausedSample.stats});
  const pendingPause=await client('player.command',{command:'pause',value:true,sessionGeneration:11,pauseRevision:2});
  const delayedLoad=await client('player.load',{url:pathToFileURL(fileB).href,profile:'music',sessionGeneration:11,paused:false,pauseRevision:0});
  const delayedSample=await sampleUntilFresh(client,5);
  results.push({step:'pause arriving before older load packet is preserved',ok:!pendingPause.error&&!delayedLoad.error&&delayedSample.ok&&delayedSample.stats.paused===true,detail:delayedSample.stats});
  const resumed=await client('player.command',{command:'pause',value:false,sessionGeneration:11,pauseRevision:3,loadId:delayedLoad.result?.loadId});
  const oldPause=await client('player.command',{command:'pause',value:true,sessionGeneration:11,pauseRevision:2,loadId:delayedLoad.result?.loadId});
  const afterOldPause=await client('player.query',{query:'stats'});
  results.push({step:'out-of-order pause cannot override newer resume',ok:!resumed.error&&Boolean(oldPause.error)&&afterOldPause.result?.paused===false,detail:oldPause.error});
  const newLoad=await client('player.load',{url:pathToFileURL(fileC).href,profile:'vod',sessionGeneration:12,paused:true,pauseRevision:0});
  await sampleUntilFresh(client,7);
  for(const command of [{command:'pause',value:false,pauseRevision:4},{command:'stop'},{command:'window-sync',x:0,y:0,width:1,height:1,visible:false}]){
    const stale=await client('player.command',{...command,sessionGeneration:11});
    results.push({step:'native rejects old '+command.command+' after takeover',ok:Boolean(stale.error?.message?.includes('PLAYBACK_SUPERSEDED')),detail:stale.error});
  }
  const stopped=await client('player.command',{command:'stop',sessionGeneration:12,loadId:newLoad.result?.loadId});
  const staleLoad=await client('player.load',{url:pathToFileURL(fileA).href,profile:'vod',sessionGeneration:12});
  results.push({step:'stop fences a delayed load in the same intent',ok:!stopped.error&&Boolean(staleLoad.error?.message?.includes('PLAYBACK_SUPERSEDED')),detail:staleLoad.error});
  const afterStop=await client('player.load',{url:pathToFileURL(fileA).href,profile:'vod',sessionGeneration:13,paused:true});
  const afterStopSample=await sampleUntilFresh(client,3);
  results.push({step:'new user intent can play after stop',ok:!afterStop.error&&afterStopSample.ok,detail:afterStopSample.stats?.loadId});
  if(process.env.FND_VERIFY_VIDEO){
    const videoPath=path.resolve(process.env.FND_VERIFY_VIDEO),duration=Number(process.env.FND_VERIFY_VIDEO_SECONDS??12);
    const video=await client('player.load',{url:pathToFileURL(videoPath).href,profile:'vod',sessionGeneration:14,paused:false});
    const decoded=await sampleUntilFresh(client,duration);
    await new Promise(resolve=>setTimeout(resolve,400));
    const first=await client('player.query',{query:'stats'}),state=await client('player.query',{query:'load-status'});
    results.push({step:'real video decodes after reconfiguration while its unrequested window stays hidden',ok:!video.error&&decoded.ok&&state.result?.status==='loaded'&&first.result?.width>0&&first.result?.height>0&&first.result?.videoSurface?.windowVisible===false,detail:first.result});
    if(process.env.FND_VERIFY_FRAME_DIR){
      const frameDir=path.resolve(process.env.FND_VERIFY_FRAME_DIR);await mkdir(frameDir,{recursive:true});
      const frames=[path.join(frameDir,'decoded-frame-0.png'),path.join(frameDir,'decoded-frame-1.png')];
      const captureA=await client('player.command',{command:'screenshot',value:frames[0],sessionGeneration:14,loadId:video.result?.loadId});
      await new Promise(resolve=>setTimeout(resolve,600));
      const captureB=await client('player.command',{command:'screenshot',value:frames[1],sessionGeneration:14,loadId:video.result?.loadId});
      const bytes=await Promise.all(frames.map(file=>readFile(file).catch(()=>Buffer.alloc(0))));
      results.push({step:'real video produces two decoded PNG frame exports',ok:!captureA.error&&!captureB.error&&bytes.every(value=>value.length>8&&value.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))),detail:{frames,captureA,captureB}});
      const later=await client('player.query',{query:'stats'}),hashes=bytes.map(value=>createHash('sha256').update(value).digest('hex'));
      results.push({step:'video playback advances and exported frame files change (not a screen-presentation assertion)',ok:later.result?.position>first.result?.position+.2&&bytes.every(value=>value.length>8)&&hashes[0]!==hashes[1],detail:{positionBefore:first.result?.position,positionAfter:later.result?.position,hashes}});
    }
    if (parentHwnd) {
      const command = (name, parameters) => client('player.command', {command:name, ...parameters});
      const bounds = {x:20,y:20,width:320,height:180,scale:1};
      const visibleEmbedded = surface => surface.mode==='embedded' && surface.windowVisible && surface.parentMatches && surface.withinParent && surface.width===320 && surface.height===180;
      for (const [step, name, parameters, matches] of [
        ['attach embedded video','window-sync',{...bounds,visible:true},visibleEmbedded],
        ['enter fullscreen','fullscreen',{value:true},surface=>surface.mode==='fullscreen'&&surface.windowVisible&&!surface.parentMatches],
        ['return from fullscreen','fullscreen',{value:false},visibleEmbedded],
        ['enter picture in picture','pip',{value:true},surface=>surface.mode==='pip'&&surface.windowVisible&&!surface.parentMatches],
        ['return from picture in picture','pip',{value:false},visibleEmbedded],
        ['hide embedded video','window-sync',{...bounds,visible:false},surface=>surface.mode==='embedded'&&!surface.windowVisible&&!surface.requestedVisible],
        ['restore embedded video','window-sync',{...bounds,visible:true},visibleEmbedded],
      ]) {
        const response=await command(name,parameters);
        let surface;
        for(let attempt=0;attempt<20;attempt++){
          surface=(await client('player.query',{query:'stats'})).result?.videoSurface;
          if(surface&&matches(surface))break;
          await new Promise(resolve=>setTimeout(resolve,50));
        }
        results.push({step,ok:!response.error&&Boolean(surface&&matches(surface)),detail:{surface,error:response.error}});
      }
    }
  }
  // Optional real-source probe: keep signed channel URLs out of the JSON report.
  if(process.env.FND_VERIFY_LIVE_PLAYLIST){
    const lines=(await readFile(process.env.FND_VERIFY_LIVE_PLAYLIST,'utf8')).split(/\r?\n/);
    const wanted=(process.env.FND_VERIFY_LIVE_NAMES??'CCTV1综合,CCTV4中文国际').split(',');
    let generation=20;
    for(const name of wanted){
      const index=lines.findIndex(line=>line.startsWith('#EXTINF:')&&line.endsWith(','+name));
      const url=lines.slice(index+1).find(line=>/^https?:\/\//.test(line));
      if(index<0||!url){results.push({step:'live '+name,ok:false,detail:'channel missing'});continue;}
      const {resolveLivePlaybackTarget}=await import('../apps/desktop/dist/main/live-playback-target.js');
      const target=await resolveLivePlaybackTarget(url,{'User-Agent':'Mozilla/5.0'},AbortSignal.timeout(8000));
      const loaded=await client('player.load',{url:target.url,headerFields:Object.entries(target.headers).map(([key,value])=>`${key}: ${value}`).join(','),profile:'live',sessionGeneration:++generation,paused:false});
      const deadline=Date.now()+30000;
      let state,stats;
      do{
        state=await client('player.query',{query:'load-status'});
        stats=await client('player.query',{query:'stats'});
        if(state.result?.status==='loaded'&&stats.result?.sampleValid&&stats.result?.width>0&&stats.result?.position>.3)break;
        if(['failed','ended'].includes(state.result?.status))break;
        await new Promise(resolve=>setTimeout(resolve,150));
      }while(Date.now()<deadline);
      const first=stats?.result;
      let framesChanged=false;
      if(first?.width>0&&process.env.FND_VERIFY_FRAME_DIR){
        const frames=[0,1].map(n=>path.resolve(process.env.FND_VERIFY_FRAME_DIR,`live-${generation}-${n}.png`));
        for(const frame of frames){await client('player.command',{command:'screenshot',value:frame,sessionGeneration:generation,loadId:loaded.result?.loadId});await new Promise(resolve=>setTimeout(resolve,1000));}
        const bytes=await Promise.all(frames.map(file=>readFile(file).catch(()=>Buffer.alloc(0))));
        framesChanged=bytes.every(value=>value.length>8)&&!bytes[0].equals(bytes[1]);
      }
      const later=await client('player.query',{query:'stats'});
      results.push({step:'live '+name,ok:!loaded.error&&state.result?.status==='loaded'&&first?.sampleValid&&first?.width>0&&(!process.env.FND_VERIFY_FRAME_DIR||framesChanged)&&later.result?.position>first?.position,detail:{state:state.result,width:first?.width,height:first?.height,positionBefore:first?.position,positionAfter:later.result?.position,framesChanged}});
    }
  }
} finally {
  socket?.destroy();
  child.kill();
  await rm(work, { recursive: true, force: true }).catch(() => undefined);
}

const failed = results.filter((item) => !item.ok);
console.log(JSON.stringify({ host: hostExe, results, passed: results.length - failed.length, failed: failed.length }, null, 2));
process.exit(failed.length ? 1 : 0);
