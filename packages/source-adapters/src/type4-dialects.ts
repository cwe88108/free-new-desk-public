export type Type4RequestMode='get'|'post-json';
export type Type4Operation='home'|'category'|'search'|'detail'|'play';

export interface Type4DialectProfile{
  id:string;
  metadataPrimary:Type4RequestMode;
  playPrimary:Type4RequestMode;
  allowMethodFallback:boolean;
  fallbackStatuses:number[];
}

const profiles:Record<string,Type4DialectProfile>={
  'tvbox-type4-v1':{id:'tvbox-type4-v1',metadataPrimary:'get',playPrimary:'post-json',allowMethodFallback:true,fallbackStatuses:[404,405,501]},
  'type4-get-v1':{id:'type4-get-v1',metadataPrimary:'get',playPrimary:'get',allowMethodFallback:false,fallbackStatuses:[]},
  'type4-post-v1':{id:'type4-post-v1',metadataPrimary:'post-json',playPrimary:'post-json',allowMethodFallback:false,fallbackStatuses:[]}
};

export function resolveType4Dialect(id?:string):Type4DialectProfile{
  if(!id)return profiles['tvbox-type4-v1']!;
  const profile=profiles[id];
  if(!profile)throw new Error(`[TYPE4_DIALECT_UNKNOWN] Unknown Type4 dialect: ${id}`);
  return profile;
}

export function type4FallbackAllowed(error:unknown,profile:Type4DialectProfile):boolean{
  if(!profile.allowMethodFallback)return false;
  const message=error instanceof Error?error.message:String(error);
  const status=Number(/HTTP\s+(\d{3})/i.exec(message)?.[1]);
  return Number.isInteger(status)&&profile.fallbackStatuses.includes(status);
}
