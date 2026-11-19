import {rm} from 'node:fs/promises';
import {safeManagedPlaylistPath} from './path-safety.js';

export const PLAYLIST_CLEANUP_KEY='internal.pendingPlaylistCleanup';
interface CleanupStore{
  getSetting(key:string):string|undefined;
  setSetting(key:string,value:string):void;
  listLiveSources():Array<{id:string}>;
}
function pending(store:CleanupStore):string[]{
  const value:unknown=JSON.parse(store.getSetting(PLAYLIST_CLEANUP_KEY)??'[]');
  if(!Array.isArray(value)||value.some(id=>typeof id!=='string'||!/^[a-z0-9-]{1,64}$/i.test(id)))throw new Error('Invalid pending playlist cleanup record');
  return [...new Set(value as string[])];
}
export function queuePlaylistCleanup(store:CleanupStore,ids:string[]):void{
  for(const id of ids)if(!/^[a-z0-9-]{1,64}$/i.test(id))throw new Error('Invalid managed playlist identifier');
  store.setSetting(PLAYLIST_CLEANUP_KEY,JSON.stringify([...new Set([...pending(store),...ids])]));
}
export function completePlaylistCleanup(store:CleanupStore,id:string):void{
  store.setSetting(PLAYLIST_CLEANUP_KEY,JSON.stringify(pending(store).filter(item=>item!==id)));
}
// Called before IPC registration: a restored source cannot race this startup pass.
export async function retryPlaylistCleanup(store:CleanupStore,root:string){
  const result={removed:0,retainedActive:0,failed:[] as Array<{sourceId:string;message:string}>};
  for(const id of pending(store)){
    if(store.listLiveSources().some(source=>source.id===id)){
      completePlaylistCleanup(store,id);result.retainedActive++;continue;
    }
    try{
      await rm(safeManagedPlaylistPath(root,id),{force:true});
      completePlaylistCleanup(store,id);result.removed++;
    }catch(error){result.failed.push({sourceId:id,message:error instanceof Error?error.message:String(error)});}
  }
  return result;
}
