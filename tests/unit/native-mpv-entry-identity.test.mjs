import {runNativeCompiler} from '../helpers/native-compiler.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

test('production MpvLoader binds loadfile result and ignores delayed previous-file events',async t=>{
  const compiler=process.env.CXX??'g++';
  if(runNativeCompiler(compiler,['--version']).status!==0){t.skip('A C++17 compiler is required');return;}
  const directory=await mkdtemp(path.join(os.tmpdir(),'fnd-mpv-entry-'));
  try{
    for(const [name,relative] of [['mpv_loader.h','include/mpv_loader.h'],['mpv_loader.cpp','src/mpv_loader.cpp']])await writeFile(path.join(directory,name),await readFile(new URL('../../native/player-host/'+relative,import.meta.url)));
    await writeFile(path.join(directory,'windows.h'),`#pragma once
using HMODULE=void*;
template<class T> inline HMODULE LoadLibraryW(const T*){return nullptr;}
inline void* GetProcAddress(HMODULE,const char*){return nullptr;}
inline void FreeLibrary(HMODULE){}
inline unsigned long GetCurrentProcessId(){return 1;}
inline unsigned long long GetTickCount64(){return 1;}
`);
    await writeFile(path.join(directory,'test.cpp'),String.raw`
#include <atomic>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>
#include <sstream>
#include <cassert>
#define private public
#include "mpv_loader.cpp"
#undef private
MpvLoader* owner;std::vector<mpv_event> events;unsigned cursor=0;int freed=0;std::int64_t nextEntry=1;bool malformed=false;
int load(mpv_handle*,const char** args,mpv_node* result){
  assert(std::string(args[0])=="loadfile");
  static char key[]="playlist_entry_id";static char* keys[]={key};static mpv_node value;static mpv_node_list map{1,&value,keys};
  value.format=MPV_FORMAT_INT64;value.u.int64=nextEntry++;
  result->format=malformed?MPV_FORMAT_NONE:MPV_FORMAT_NODE_MAP;result->u.list=&map;return 0;
}
void freeResult(mpv_node*){++freed;}
mpv_event* wait(mpv_handle*,double){if(cursor<events.size())return &events[cursor++];owner->stopEvents_=true;return nullptr;}
void deliver(MpvLoader& player,std::vector<mpv_event> input){events=std::move(input);cursor=0;player.stopEvents_=false;player.eventLoop();}
int main(){MpvLoader p;owner=&p;p.handle_=reinterpret_cast<mpv_handle*>(1);p.commandRet_=load;p.freeNodeContents_=freeResult;p.waitEvent_=wait;
  std::string id,error;assert(p.startLoad("a","",id,error));assert(p.activeEntryId_==1);
  assert(p.startLoad("b","",id,error));assert(p.activeEntryId_==2&&freed==2);
  mpv_event_start_file_head a{1},b{2},child{3};
  deliver(p,{{MPV_EVENT_START_FILE,0,0,&a},{MPV_EVENT_FILE_LOADED,0,0,nullptr}});
  assert(p.loadState().status=="loading"&&!p.sampleReady()&&p.activeEntryId_==2);
  deliver(p,{{MPV_EVENT_START_FILE,0,0,&b},{MPV_EVENT_FILE_LOADED,0,0,nullptr}});
  assert(p.loadState().status=="loaded"&&p.sampleReady());
  // A replaced file's terminal event cannot finish the current load.
  mpv_event_end_file_head oldEnd{MPV_END_FILE_REASON_EOF,0,1,0,0};
  deliver(p,{{MPV_EVENT_END_FILE,0,0,&oldEnd}});assert(p.sampleReady());
  // Playlist expansion remains a legitimate continuation with its explicit child ID.
  mpv_event_end_file_head redirect{MPV_END_FILE_REASON_REDIRECT,0,2,3,1};
  deliver(p,{{MPV_EVENT_END_FILE,0,0,&redirect},{MPV_EVENT_START_FILE,0,0,&a},{MPV_EVENT_FILE_LOADED,0,0,nullptr}});
  assert(p.loadState().status=="loading"&&!p.sampleReady()&&p.activeEntryId_==3);
  deliver(p,{{MPV_EVENT_START_FILE,0,0,&child},{MPV_EVENT_FILE_LOADED,0,0,nullptr}});assert(p.sampleReady());
  // Missing command identity must fail closed, with the returned node freed.
  malformed=true;assert(!p.startLoad("unsupported","",id,error));assert(freed==3&&p.loadState().status=="failed"&&!p.sampleReady());
}
`);
    const binary=path.join(directory,process.platform==='win32'?'test.exe':'test');
    const build=runNativeCompiler(compiler,['-std=c++17','-pthread','-I',directory,path.join(directory,'test.cpp'),'-o',binary],{encoding:'utf8'});
    assert.equal(build.status,0,build.stderr);
    const run=spawnSync(binary,[],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
  }finally{await rm(directory,{recursive:true,force:true});}
});
