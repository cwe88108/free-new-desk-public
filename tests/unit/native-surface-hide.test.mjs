import {runNativeCompiler} from '../helpers/native-compiler.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const source=await readFile(new URL('../../native/player-host/src/main.cpp',import.meta.url),'utf8');
function section(from,to){return source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));}
const compiler=process.env.CXX||'g++';
const available=runNativeCompiler(compiler,['--version'],{encoding:'utf8'}).status===0;

test('native hide executes real production functions against synchronous Win32/mpv fakes',{skip:available?false:'C++ compiler unavailable; Windows packaged smoke remains required'},async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fnd-surface-hide-'));
  try{
    const cpp=String.raw`
#include <cassert>
#include <string>
#include <optional>
#include <mutex>
#include <cstdint>
#include <chrono>
#include <sstream>
using HWND=void*;using DWORD=unsigned long;using UINT=unsigned;using LPARAM=std::intptr_t;
constexpr UINT SWP_NOMOVE=1,SWP_NOSIZE=2,SWP_NOZORDER=4,SWP_NOACTIVATE=8,SWP_HIDEWINDOW=16;
struct WindowSearch{DWORD pid;HWND window;bool visibleOnly;};
struct Surface{bool valid=false,visible=false;double x=0,y=0,width=1,height=1,scale=1;}g_surface;
HWND first=reinterpret_cast<HWND>(1),second=reinterpret_cast<HWND>(2),g_playerWindow=first,found=first;
bool g_fullscreen=false,g_pip=false,visible=true,windowExists=true,hideFails=false,staysVisible=false;
int finds=0,hides=0,applies=0,parents=0,commands=0,properties=0;UINT flags=0;
std::mutex g_surfaceMutex;
bool IsWindow(HWND){return windowExists;}
constexpr int GWL_STYLE=0,WS_VISIBLE=32;
std::intptr_t GetWindowLongPtrW(HWND,int){return visible?WS_VISIBLE:0;}
bool parentVisible=false;
bool IsWindowVisible(HWND){return visible&&parentVisible;}
DWORD GetCurrentProcessId(){return 1;}
DWORD GetLastError(){return 5;}
void find_process_window(){}
void EnumWindows(void(*)(),LPARAM value){++finds;reinterpret_cast<WindowSearch*>(value)->window=found;}
bool SetWindowPos(HWND window,HWND,int,int,int,int,UINT value){assert(window==g_playerWindow);++hides;flags=value;if(hideFails)return false;if(!staysVisible)visible=false;return true;}
HWND electron_window(){++parents;return first;}
UINT GetDpiForWindow(HWND){return 144;}
bool apply_embedded_surface(std::string&){++applies;visible=g_surface.visible;return true;}
struct MpvLoader{bool reject=false;bool setProperty(const char*,const char*,std::string& error){++properties;if(reject){error="rejected";return false;}return true;}};
void disable_live_fullscreen_keys(MpvLoader&){++commands;}
`+section('using SurfaceClock=','struct WindowSearch')+section('std::optional<double> json_number','std::string ok(')+section('bool hide_player_window(','\nbool enter_fullscreen')+String.raw`
int main(){
 MpvLoader mpv;std::string error;g_surfaceTrace={SurfaceClock::now()};
 const std::string hide=R"({"x":20,"y":40,"width":640,"height":360,"scale":2,"visible":false})";
 const std::string show=R"({"x":20,"y":40,"width":640,"height":360,"scale":2,"visible":true})";
 // Embedded release needs exactly one synchronous visibility operation, no mpv,
 // parent lookup, geometry, style or frame work. Repeated release is a no-op.
 assert(sync_window(mpv,hide,error));assert(!visible&&!g_surface.visible);
 assert(g_surfaceTrace.surfaceLockMs>=0&&g_surfaceTrace.applyMs>=0);
 const auto traced=with_surface_trace(R"({"result":{"ok":true}})");
 assert(traced.find("surfaceTiming")!=std::string::npos&&traced.find("commandLockMs")!=std::string::npos&&traced.find("surfaceLockMs")!=std::string::npos&&traced.find("applyMs")!=std::string::npos&&traced.find("totalMs")!=std::string::npos);
 parentVisible=true;assert(!IsWindowVisible(g_playerWindow)); // Restoring the parent cannot resurrect the released child.
 assert(hides==1&&properties==0&&commands==0&&parents==0&&applies==0&&finds==0);
 assert(flags==(SWP_NOMOVE|SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE|SWP_HIDEWINDOW));
 assert(sync_window(mpv,hide,error)&&hides==1);
 // Showing again restores the complete embedding/geometry path and pixel scale.
 assert(sync_window(mpv,show,error)&&visible&&applies==1&&g_surface.scale==2);
 // Cross-window handle replacement must hide the new live window, not the stale handle.
 g_playerWindow=first;windowExists=false;found=second;
 assert(sync_window(mpv,hide,error)&&g_playerWindow==second&&finds==1&&!visible);
 windowExists=true;g_playerWindow=nullptr;found=nullptr;
 assert(sync_window(mpv,hide,error)&&finds==2); // No wait for an absent window.
 g_playerWindow=second;visible=true;hideFails=true;
 assert(!sync_window(mpv,hide,error)&&visible&&!error.empty());
 hideFails=false;staysVisible=true;
 assert(!sync_window(mpv,hide,error)&&visible); // ACK requires observed hidden state.
 staysVisible=false;g_fullscreen=true;
 assert(sync_window(mpv,hide,error)&&!visible&&!g_fullscreen&&properties==1&&commands==1);
 visible=true;g_pip=true;
 assert(sync_window(mpv,hide,error)&&!g_pip&&!visible&&properties==2);
 visible=true;g_fullscreen=true;mpv.reject=true;
 assert(!sync_window(mpv,hide,error)&&g_fullscreen); // Failed exit is not acknowledged.
}
`;
    const input=join(dir,'test.cpp'),output=join(dir,process.platform==='win32'?'test.exe':'test');
    await writeFile(input,cpp);
    const build=runNativeCompiler(compiler,['-std=c++20',input,'-o',output],{encoding:'utf8'});
    assert.equal(build.status,0,build.stderr);
    const run=spawnSync(output,[],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
  }finally{await rm(dir,{recursive:true,force:true});}
});
