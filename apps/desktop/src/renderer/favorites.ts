import type {DetailResult,VodFavorite} from '@free-new-desk/contracts';
export type {VodFavorite} from '@free-new-desk/contracts';
export async function listVodFavorites():Promise<VodFavorite[]>{return(await window.desktop.vodFavorites.list()).items;}
export async function isVodFavorite(sourceId:string,videoId:string):Promise<boolean>{return(await listVodFavorites()).some(item=>item.sourceId===sourceId&&item.videoId===videoId);}
export async function toggleVodFavorite(sourceId:string,sourceName:string,detail:DetailResult):Promise<boolean>{
  const item:VodFavorite={sourceId,sourceName,videoId:detail.id,name:detail.name,createdAt:new Date().toISOString(),...(detail.poster?{poster:detail.poster}:{}),...(detail.remark?{remark:detail.remark}:{})};
  const result=await window.desktop.vodFavorites.mutate({kind:'toggle',item});
  if(typeof result.favorite!=='boolean')throw new Error('收藏服务未确认操作结果');return result.favorite;
}
export async function removeVodFavorites(items:Array<Pick<VodFavorite,'sourceId'|'videoId'>>):Promise<void>{await window.desktop.vodFavorites.mutate({kind:'remove',items});}
export async function removeVodFavorite(sourceId:string,videoId:string):Promise<void>{await removeVodFavorites([{sourceId,videoId}]);}
export async function renameVodFavorite(sourceId:string,videoId:string,label:string):Promise<void>{await window.desktop.vodFavorites.mutate({kind:'rename',sourceId,videoId,label});}
