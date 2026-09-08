export function buildLiveChannelIndex<T extends {id:string}>(groups:ReadonlyArray<{channels:T[]}>):{channels:T[];byId:Map<string,T>;indexById:Map<string,number>}{
  const channels=groups.flatMap(group=>group.channels);
  return{channels,byId:new Map(channels.map(channel=>[channel.id,channel])),indexById:new Map(channels.map((channel,index)=>[channel.id,index]))};
}

export function buildCurrentProgramIndex<T extends {channelId:string;start:string;stop:string}>(programs:ReadonlyArray<T>,now=Date.now()):Map<string,T>{
  const result=new Map<string,T>();
  for(const program of programs)if(new Date(program.start).getTime()<=now&&new Date(program.stop).getTime()>now&&!result.has(program.channelId))result.set(program.channelId,program);
  return result;
}
