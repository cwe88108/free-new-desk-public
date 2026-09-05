import { z } from 'zod';

export const SourceKindSchema=z.enum(['T0_XML','T1_JSON','T4_EXT','T3_JS','T3_XYQ','T3_XBPQ','T4_CATVOD','DRIVE_ALIST','T3_JAR','PLUGIN']);
export type SourceKind=z.infer<typeof SourceKindSchema>;
export const SourceConfigSchema=z.object({id:z.string().min(1),name:z.string().min(1).max(80),kind:SourceKindSchema,endpoint:z.string().min(1),enabled:z.boolean(),trust:z.enum(['A','B']),ext:z.string().optional(),jar:z.string().optional(),headers:z.record(z.string()).optional(),searchable:z.boolean().optional(),categories:z.array(z.string()).optional(),playUrl:z.string().optional(),playerType:z.number().int().optional(),configShell:z.string().optional(),importGroupId:z.string().optional(),sourceLabel:z.string().optional(),importedAt:z.string().optional()});
export type SourceConfig=z.infer<typeof SourceConfigSchema>;
export const SourceSummarySchema=SourceConfigSchema.pick({id:true,name:true,kind:true,enabled:true,trust:true,searchable:true});
export type SourceSummary=z.infer<typeof SourceSummarySchema>;

export const VideoCardSchema=z.object({id:z.string(),name:z.string(),poster:z.string().optional(),remark:z.string().optional(),rating:z.string().optional()});
export type VideoCard=z.infer<typeof VideoCardSchema>;
export interface SourceCategory{id:string;name:string;}
export interface SourceFilterOption{label:string;value:string;}
export interface SourceFilter{key:string;name:string;options:SourceFilterOption[];}
export interface HomeResult{items:VideoCard[];categories?:SourceCategory[];filters?:Record<string,SourceFilter[]>;}
export interface CategoryResult{page:number;hasMore:boolean;items:VideoCard[];totalPages?:number;totalItems?:number;}
export interface SearchResult{page:number;items:VideoCard[];}
export const EpisodeSchema=z.object({flag:z.string(),id:z.string().min(1),name:z.string()});
export type Episode=z.infer<typeof EpisodeSchema>;
export interface DetailResult{id:string;name:string;poster?:string|undefined;remark?:string|undefined;description?:string|undefined;rating?:string|undefined;year?:string|undefined;area?:string|undefined;type?:string|undefined;director?:string|undefined;actors?:string[]|undefined;episodes:Episode[];}

export interface SubtitleTrack{url:string;name?:string;language?:string;}
export interface DanmakuSource{url:string;name?:string;}
export interface DRMInfo{type:string;licenseUrl?:string;headers?:Record<string,string>;}
export interface PlayResult{url:string;parse:boolean;headers?:Record<string,string>;userAgent?:string;referer?:string;subtitles?:SubtitleTrack[];danmaku?:DanmakuSource[];drm?:DRMInfo;}

export interface SourceContext{sourceId:string;proxyBaseUrl?:string;proxyToken?:string;requestHeaders?:Record<string,string>;}
export interface SourceAdapter{init(ctx:SourceContext):Promise<void>;getHome():Promise<HomeResult>;getCategory(categoryId:string,page:number,filters?:Record<string,string>):Promise<CategoryResult>;getDetail(ids:string[]):Promise<DetailResult>;search(keyword:string,page?:number):Promise<SearchResult>;getPlay(flag:string,id:string):Promise<PlayResult>;destroy():Promise<void>;}
export interface AppError{code:string;message:string;recoverable:boolean;source?:string;detail?:string;traceId?:string;}

export const LiveSourceConfigSchema=z.object({id:z.string().min(1),name:z.string().min(1),endpoint:z.string().min(1),enabled:z.boolean(),epg:z.string().optional(),logo:z.string().optional(),headers:z.record(z.string()).optional(),origin:z.enum(['tvbox','remote-playlist','local-file','manual']).optional(),sourceLabel:z.string().optional(),importedAt:z.string().optional(),importGroupId:z.string().optional()});
export type LiveSourceConfig=z.infer<typeof LiveSourceConfigSchema>;
export interface LiveChannel{id:string;name:string;url:string;urls?:string[];group:string;logo?:string;tvgId?:string;headers?:Record<string,string>;}
export interface LiveGroup{name:string;channels:LiveChannel[];}
export interface LiveRouteSpeed{index:number;ok:boolean;latencyMs:number;bytes:number;kbps:number;message?:string;}
export interface LiveFavorite{liveSourceId:string;channelId:string;channelName:string;group:string;url:string;urls:string[];logo?:string;tvgId?:string;createdAt:string;}
export interface EpgProgram{channelId:string;title:string;start:string;stop:string;description?:string;}
export type CompatibilityStage='preflight'|'boot'|'load'|'init'|'invoke'|'network'|'normalize';
export interface SourceCompatibilityResult{sourceId:string;sourceName:string;sourceType:'vod'|'live';compatible:boolean;stage:CompatibilityStage;retryable:boolean;checkedAt:string;durationMs:number;reason?:string;}
export interface ImportGroupRemovalResult{importGroupId:string;pointSources:number;liveSources:number;history:number;health:number;liveFavorites:number;epgPrograms:number;reservations:number;managedFiles:number;}
export interface TVBoxImportResult{sources:SourceConfig[];liveSources:LiveSourceConfig[];warnings:string[];importGroupId?:string;sourceLabel?:string;importedAt?:string;compatibility?:SourceCompatibilityResult[];}

export interface PlaybackHistoryEntry{id:string;sourceId:string;sourceName:string;videoId:string;videoName:string;episodeName:string;url:string;playedAt:string;flag?:string;episodeId?:string;poster?:string;episodes?:Episode[];position?:number;duration?:number;}
export interface SourceHealth{sourceId:string;ok:boolean;latencyMs:number;checkedAt:string;score:number;message?:string;successCount?:number;failureCount?:number;successRate?:number;lastSuccess?:string;lastFailure?:string;failureReason?:string;compatibilityStage?:CompatibilityStage;retryable?:boolean;}
export interface SourceAuditStage{stage:string;ok:boolean;durationMs:number;message?:string;}
export interface SourceAuditResult{sourceId:string;ok:boolean;stages:SourceAuditStage[];checkedAt:string;notice?:string;}
export interface ProgramReservation{id:string;liveSourceId:string;channelId:string;channelName:string;programTitle:string;start:string;createdAt:string;}
export interface AppSetting{key:string;value:string;}

export interface PlayerTrack{id:string;type:string;title?:string;language?:string;selected:boolean;}
export interface PlayerStats{position:number;duration:number;paused:boolean;muted:boolean;volume:number;speed:number;cacheDuration:number;pausedForCache?:boolean;cacheBytes?:number;cacheMaxBytes?:number;hwdec?:string;videoFormat?:string;audioFormat?:string;containerFormat?:string;width?:number;height?:number;fps?:number;videoBitrate?:number;audioBitrate?:number;sampleRate?:number;audioChannels?:number;path?:string;fileSize?:number;}
export interface PlayerLoadStatus{loadId:string;status:'idle'|'loading'|'loaded'|'failed'|'ended';error?:string;}
export const PlayerCommandSchema=z.discriminatedUnion('command',[
  z.object({command:z.literal('pause'),value:z.boolean()}),z.object({command:z.literal('seek'),value:z.number(),absolute:z.boolean().optional()}),z.object({command:z.literal('volume'),value:z.number().min(0).max(100)}),z.object({command:z.literal('mute'),value:z.boolean()}),z.object({command:z.literal('speed'),value:z.number().min(0.25).max(4)}),z.object({command:z.literal('stop')}),z.object({command:z.literal('subtitle-add'),value:z.string().min(1)}),z.object({command:z.literal('audio-track'),value:z.string()}),z.object({command:z.literal('subtitle-track'),value:z.string()}),z.object({command:z.literal('subtitle-delay'),value:z.number()}),z.object({command:z.literal('audio-delay'),value:z.number()}),z.object({command:z.literal('aspect-ratio'),value:z.string().min(1).max(32)}),z.object({command:z.literal('hwdec'),value:z.enum(['auto-safe','no'])}),z.object({command:z.literal('pip'),value:z.boolean()}),z.object({command:z.literal('fullscreen'),value:z.boolean()}),z.object({command:z.literal('screenshot'),value:z.string().min(1)}),z.object({command:z.literal('window-sync'),x:z.number(),y:z.number(),width:z.number().int().min(1),height:z.number().int().min(1),scale:z.number().positive().max(8).optional(),visible:z.boolean()})
]);
export type PlayerCommand=z.infer<typeof PlayerCommandSchema>;
export type PlayerQuery='stats'|'tracks'|'load-status';

export const SourceIdRequestSchema=z.object({sourceId:z.string().min(1)});
export const SourceSearchRequestSchema=z.object({sourceId:z.string().min(1),keyword:z.string().min(1).max(100),page:z.number().int().positive().optional()});
export const SourceCategoryRequestSchema=z.object({sourceId:z.string().min(1),categoryId:z.string().min(1),page:z.number().int().positive().optional(),filters:z.record(z.string()).optional()});
export const SourceDetailRequestSchema=z.object({sourceId:z.string().min(1),ids:z.array(z.string().min(1)).min(1).max(20)});
export const PlaybackEpisodeRequestSchema=z.object({sourceId:z.string().min(1),videoId:z.string().min(1),videoName:z.string().min(1),flag:z.string(),episodeId:z.string().min(1),episodeName:z.string().min(1),poster:z.string().max(4096).optional(),episodeListJson:z.string().max(262144).optional()});
export type PlaybackEpisodeRequest=z.infer<typeof PlaybackEpisodeRequestSchema>;
export const PlayRequestSchema=z.object({url:z.string().min(1),headers:z.record(z.string()).optional(),headerFields:z.string().optional(),profile:z.enum(['vod','live']).optional()});
export type PlayRequest=z.infer<typeof PlayRequestSchema>;

export type SourceEngineRequest=
  {id:string;method:'source.ping'}|
  {id:string;method:'source.configure';params:{proxyBaseUrl?:string;proxyToken?:string}}|
  {id:string;method:'source.replaceAll';params:{sources:SourceConfig[]}}|
  {id:string;method:'source.list'}|
  {id:string;method:'source.home';params:{sourceId:string}}|
  {id:string;method:'source.category';params:{sourceId:string;categoryId:string;page?:number;filters?:Record<string,string>}}|
  {id:string;method:'source.search';params:{sourceId:string;keyword:string;page?:number}}|
  {id:string;method:'source.detail';params:{sourceId:string;ids:string[]}}|
  {id:string;method:'source.play';params:{sourceId:string;flag:string;episodeId:string}}|
  {id:string;method:'source.audit';params:{sourceId:string}};
export type SourceEngineResult={ok:true;version?:string}|SourceSummary[]|HomeResult|CategoryResult|SearchResult|DetailResult|PlayResult|SourceAuditResult;
export type SourceEngineResponse={id:string;result:SourceEngineResult}|{id:string;error:AppError};
