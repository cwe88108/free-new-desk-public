// Observation-copy only. Preserve invocation results and collect timings in memory.
const benchmarkInvoke=ipcRenderer.invoke.bind(ipcRenderer);
contextBridge.exposeInMainWorld('fndBenchmark',{sourceCount:Number(process.env.FND_BENCH_SOURCE_COUNT??0)});
const benchmarkSamples:Record<string,number[]>={};
let benchmarkStopped=true;
ipcRenderer.invoke=async(channel:string,...args:unknown[])=>{
  if(channel==='diagnostics:recordPerformance'&&(args[0] as {metric?:unknown})?.metric==='benchmarkMeasuredStart'){for(const key of Object.keys(benchmarkSamples))delete benchmarkSamples[key];benchmarkStopped=false;}
  if(channel==='diagnostics:recordPerformance'&&(args[0] as {metric?:unknown})?.metric==='benchmarkMeasuredEnd')benchmarkStopped=true;
  if(channel==='diagnostics:recordPerformance'&&(args[0] as {metric?:unknown})?.metric==='benchmarkComplete')await benchmarkInvoke('benchmark:preloadEvidence',benchmarkSamples);
  const at=performance.now();
  const inWorkload=!benchmarkStopped;
  try{return await benchmarkInvoke(channel,...args);}
  finally{
    if(channel==='playback:query'&&inWorkload&&!benchmarkStopped){
      const input=args[0],query=typeof input==='string'?input:(input as {query?:unknown})?.query;
      const name=query==='stats'?'playbackStatsIpcMs':query==='load-status'?'playbackLoadStatusIpcMs':query==='tracks'?'playbackTracksIpcMs':undefined;
      if(name){const values=benchmarkSamples[name]??=[];if(values.length<20_000)values.push(performance.now()-at);}
    }
  }
};
