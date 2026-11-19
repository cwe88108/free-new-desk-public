import {runNativeCompiler} from '../helpers/native-compiler.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

test('native generation fence rejects reverse same-session route loads and preserves stop',async t=>{
  const compiler=process.env.CXX??'g++';
  if(runNativeCompiler(compiler,['--version']).status!==0){t.skip('A C++17 compiler is required');return;}
  const source=await readFile(new URL('../../native/player-host/src/main.cpp',import.meta.url),'utf8');
  const helper=source.match(/bool accept_generation\([\s\S]*?\n\}/)?.[0];
  assert.ok(helper);
  const directory=await mkdtemp(path.join(os.tmpdir(),'fnd-native-generation-'));
  try{
    const cpp=`#include <string>
#include <optional>
#include <cmath>
#include <cstdint>
#include <iostream>
std::uint64_t g_authoritativeGeneration=0,g_loadGeneration=0,g_pauseRevision=0;
bool g_authorityStopped=false,g_desiredPaused=false;
std::optional<double> json_number(const std::string& request,const std::string& key){
  auto split=request.find(',');auto value=key=="sessionGeneration"?request.substr(0,split):request.substr(split+1);
  if(value=="none")return std::nullopt;return std::stod(value);
}
${helper}
int main(){std::string error;
#define CHECK(condition) if(!(condition)){std::cerr<<"Failed: "<<#condition<<std::endl;return 1;}
  CHECK(accept_generation("5,11",true,error));
  CHECK(!accept_generation("5,10",true,error));
  CHECK(accept_generation("5,11",true,error)); // same load retry remains permitted
  CHECK(!accept_generation("4,99",true,error)); // old domain
  CHECK(accept_generation("5,none",false,error)); // commands do not need load generation
  g_authorityStopped=true;
  CHECK(!accept_generation("5,12",true,error));
  CHECK(accept_generation("6,1",true,error)); // new session resets route fence
  CHECK(!accept_generation("6,-1",true,error));
  CHECK(!accept_generation("6,1.5",true,error));
  CHECK(!accept_generation("6,9007199254740992",true,error));
  CHECK(accept_generation("6,2",true,error));
}
`;
    const input=path.join(directory,'test.cpp'),binary=path.join(directory,process.platform==='win32'?'test.exe':'test');
    await writeFile(input,cpp);
    const build=runNativeCompiler(compiler,['-std=c++17',input,'-o',binary],{encoding:'utf8'});
    assert.equal(build.status,0,build.stderr);
    const run=spawnSync(binary,[],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('production native RPC handler fences stale stop and stops an unacknowledged route replacement',async t=>{
  const compiler=process.env.CXX??'g++';
  if(runNativeCompiler(compiler,['--version']).status!==0){t.skip('A C++17 compiler is required');return;}
  const source=await readFile(new URL('../../native/player-host/src/main.cpp',import.meta.url),'utf8');
  const section=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
  const helpers=section('std::string escape_json','std::string property(');
  const commands=section('bool accept_generation(','} // namespace');
  const start=source.indexOf('[&](const std::string& request){'),end=source.indexOf(');return server.run();}',start);
  assert.ok(start>0&&end>start);
  const handler=source.slice(start,end);
  const directory=await mkdtemp(path.join(os.tmpdir(),'fnd-native-stop-'));
  try{
    const cpp=String.raw`
#include <string>
#include <optional>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <sstream>
#include <vector>
#include <algorithm>
#include <mutex>
#include <atomic>
#include <chrono>
#include <cassert>
`+helpers+String.raw`
struct State{std::string loadId,status,error;};
struct CacheUsage{std::int64_t forwardBytes=0,totalBytes=0;};
struct MpvLoader{
  State state;int loads=0,stops=0;bool playing=false;
  bool setProperty(const std::string&,const std::string&,std::string&){return true;}
  bool command(const std::vector<std::string>& args,std::string&){if(args[0]=="stop"){++stops;playing=false;state.status="ended";}return true;}
  State loadState(){return state;}
  bool sampleReady(){return state.status=="loaded";}
  CacheUsage cacheUsage(){return {};}
  std::int64_t getIntegerProperty(const char*){return 0;}
  bool startLoad(const std::string&,const std::string&,std::string& id,std::string&){id="load-"+std::to_string(++loads);state={id,"loaded",""};playing=true;return true;}
};
std::uint64_t g_authoritativeGeneration=0,g_loadGeneration=0,g_pauseRevision=0,g_seekRevision=0,g_sampleSeq=0;
bool g_authorityStopped=false,g_desiredPaused=false;
std::atomic<bool> g_liveProfile=false;
std::string g_hostEpoch="test-host";
using SurfaceClock=std::chrono::steady_clock;
struct Trace{SurfaceClock::time_point received;double commandLockMs=0;}g_surfaceTrace;
double surface_elapsed_ms(SurfaceClock::time_point){return 0;}
std::string with_surface_trace(std::string response){return response;}
bool enter_pip(MpvLoader&,std::string&){return true;}
bool exit_pip(MpvLoader&,std::string&){return true;}
bool enter_fullscreen(MpvLoader&,std::string&){return true;}
bool exit_fullscreen(MpvLoader&,std::string&){return true;}
bool sync_window(MpvLoader&,const std::string&,std::string&){return true;}
void disable_live_fullscreen_keys(MpvLoader&){}
std::mutex g_surfaceMutex;bool g_fullscreen=false,g_pip=false;std::uint64_t g_inputSequence=0;std::string g_inputKey,mediaPath="old.avi";
void reconcile_fullscreen(MpvLoader&){}
void poll_fullscreen_input_locked(){}
std::string video_surface_json_locked(){return "{}";}
double property_number(MpvLoader&,const std::string& name,double fallback=0){return name=="duration"?30:name=="time-pos"?5:fallback;}
bool property_bool(MpvLoader&,const std::string&,bool fallback=false){return fallback;}
std::string property(MpvLoader&,const std::string& name,const std::string& fallback=""){return name=="path"?mediaPath:fallback;}
`+section('std::string stats_json(','std::string tracks_json(')+String.raw`
std::string tracks_json(MpvLoader&){return "[]";}
`+commands+String.raw`
int main(){MpvLoader mpv;bool ready=true;std::string initError,activeProfile;std::mutex loadMutex;
  const std::string defaultCacheSecs="3600",defaultCacheDonation="yes";
  auto dispatch=`+handler+String.raw`;
  const auto succeeded=[](const std::string& response){return response.find("\"error\"")==std::string::npos;};
  assert(succeeded(dispatch(R"({"id":"a","method":"player.load","params":{"sessionGeneration":1,"generation":1,"profile":"vod","url":"a"}})")));
  assert(succeeded(dispatch(R"({"id":"b","method":"player.load","params":{"sessionGeneration":2,"generation":2,"profile":"live","url":"b"}})")));
  // An old stop without a load ID must still be rejected after a new domain wins.
  assert(!succeeded(dispatch(R"({"id":"old-stop","method":"player.command","params":{"command":"stop","sessionGeneration":1}})")));
  assert(mpv.playing&&mpv.stops==0&&mpv.state.loadId=="load-2");
  assert(succeeded(dispatch(R"({"id":"stop","method":"player.command","params":{"command":"stop","sessionGeneration":2}})")));
  assert(!mpv.playing&&mpv.stops==1);
  // A pending same-session load cannot resurrect playback after stop.
  assert(!succeeded(dispatch(R"({"id":"late-load","method":"player.load","params":{"sessionGeneration":2,"generation":3,"profile":"live","url":"late"}})")));
  assert(mpv.loads==2&&!mpv.playing);
  assert(succeeded(dispatch(R"({"id":"c","method":"player.load","params":{"sessionGeneration":3,"generation":4,"profile":"live","url":"c"}})")));
  // Native executes replacement D, while the renderer/client still knows C's load ID.
  const auto pendingAck=dispatch(R"({"id":"d","method":"player.load","params":{"sessionGeneration":3,"generation":5,"profile":"live","url":"d"}})");
  assert(succeeded(pendingAck)&&mpv.state.loadId=="load-4");
  assert(!succeeded(dispatch(R"({"id":"old-payload","method":"player.command","params":{"command":"stop","sessionGeneration":3,"loadId":"load-3"}})")));
  assert(mpv.playing&&mpv.stops==1); // Demonstrates why the old TS payload was incorrect.
  assert(succeeded(dispatch(R"({"id":"fixed-payload","method":"player.command","params":{"command":"stop","sessionGeneration":3}})")));
  assert(!mpv.playing&&mpv.stops==2);
  assert(!succeeded(dispatch(R"({"id":"late-route","method":"player.load","params":{"sessionGeneration":3,"generation":6,"profile":"live","url":"late"}})")));
  assert(mpv.loads==4&&!mpv.playing);
  assert(succeeded(dispatch(R"({"id":"newest-route","method":"player.load","params":{"sessionGeneration":4,"generation":8,"profile":"live","url":"newest"}})")));
  assert(!succeeded(dispatch(R"({"id":"older-route","method":"player.load","params":{"sessionGeneration":4,"generation":7,"profile":"live","url":"older"}})")));
  assert(mpv.loads==5&&mpv.playing&&mpv.state.loadId=="load-5");
  // libmpv may still expose the previous path/duration while the new native load ID is loading.
  mpv.state.status="loading";
  const auto oldProperties=dispatch(R"({"id":"pending-stats","method":"player.query","params":{"query":"stats"}})");
  assert(oldProperties.find("old.avi")!=std::string::npos);
  assert(oldProperties.find("\"sampleValid\":false")!=std::string::npos);
  mpv.state.status="loaded";mediaPath="new.avi";
  const auto confirmed=dispatch(R"({"id":"fresh-stats","method":"player.query","params":{"query":"stats"}})");
  assert(confirmed.find("new.avi")!=std::string::npos);
  assert(confirmed.find("\"sampleValid\":true")!=std::string::npos);
}
`;
    const input=path.join(directory,'test.cpp'),binary=path.join(directory,process.platform==='win32'?'test.exe':'test');
    await writeFile(input,cpp);
    const build=runNativeCompiler(compiler,['-std=c++17',input,'-o',binary],{encoding:'utf8'});
    assert.equal(build.status,0,build.stderr||build.stdout);
    const run=spawnSync(binary,[],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
  }finally{await rm(directory,{recursive:true,force:true});}
});
