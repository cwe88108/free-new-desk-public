import {z} from 'zod';

const identity=z.string().min(1).max(16_384).refine(value=>!value.includes('\u0000'),'收藏标识不能包含空字符');
const text=z.string().max(8192);
const createdAt=z.string().max(64).datetime({offset:true}).refine(value=>Number.isFinite(Date.parse(value)),'收藏日期无效').transform(value=>new Date(value).toISOString());
export const FavoriteIdentitySchema=z.object({sourceId:identity,videoId:identity});
export const VodFavoriteSchema=FavoriteIdentitySchema.extend({sourceName:text,name:text.min(1),poster:text.optional(),remark:text.optional(),label:text.trim().min(1).optional(),createdAt});
export const VodFavoritesSchema=z.array(VodFavoriteSchema).max(5000);
export type VodFavorite=z.infer<typeof VodFavoriteSchema>;
export const LiveFavoriteSchema=z.object({liveSourceId:identity,channelId:identity,channelName:text.min(1),group:text,url:text.min(1),urls:z.array(text.min(1)).max(16),logo:text.optional(),tvgId:text.optional(),createdAt});
export const FavoritesImportSchema=z.object({version:z.literal(1).optional(),vod:VodFavoritesSchema.optional(),live:z.array(LiveFavoriteSchema).max(5000).optional()}).refine(value=>value.vod!==undefined||value.live!==undefined,'收藏文件缺少vod/live数组');
export const VodFavoriteMutationSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('toggle'),item:VodFavoriteSchema}),
  z.object({kind:z.literal('remove'),items:z.array(FavoriteIdentitySchema).max(5000)}),
  FavoriteIdentitySchema.extend({kind:z.literal('rename'),label:text.trim().min(1)}),
]);
export type VodFavoriteMutation=z.infer<typeof VodFavoriteMutationSchema>;
export interface VodFavoriteState{items:VodFavorite[];invalidCount:number;recoveryAvailable:boolean;}
export interface VodFavoriteMutationResult extends VodFavoriteState{favorite?:boolean;}
export const VOD_FAVORITES_KEY='vod.favorites',VOD_FAVORITES_RECOVERY_KEY='vod.favorites.recovery';
export const FAVORITES_MAX_BYTES=8*1024*1024;
export function favoriteIdentity(item:{sourceId:string;videoId:string}):string{return JSON.stringify([item.sourceId,item.videoId]);}
