import { defineStore } from 'pinia';
import { shallowRef } from 'vue';

type Snapshot={savedAt:number;value:unknown};
const DEFAULT_TTL_MS=60_000;

export const usePageStateStore=defineStore('page-state',()=>{
  const snapshots=shallowRef<Record<string,Snapshot>>({});
  function save<T>(key:string,value:T):void{snapshots.value={...snapshots.value,[key]:{savedAt:Date.now(),value}};}
  function read<T>(key:string,ttlMs=DEFAULT_TTL_MS):{savedAt:number;value:T}|undefined{const entry=snapshots.value[key];if(!entry)return undefined;if(Date.now()-entry.savedAt>ttlMs){const next={...snapshots.value};delete next[key];snapshots.value=next;return undefined;}return{savedAt:entry.savedAt,value:entry.value as T};}
  function clear(key?:string):void{if(!key){snapshots.value={};return;}const next={...snapshots.value};delete next[key];snapshots.value=next;}
  return{save,read,clear};
});
