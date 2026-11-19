export function nowPlayingTitle(path:string|undefined,history:{id:string;videoName:string;episodeName:string}|null,runtime:{domain:string|null;historyId?:string}):string{
  if(runtime.domain==='vod'&&history&&history.id===runtime.historyId&&history.videoName)return[history.videoName,history.episodeName].filter(Boolean).join(' · ');
  if(!path)return'';
  const segment=path.split(/[?#]/,1)[0]!.split(/[\\/]/).filter(Boolean).pop()??'';
  let name=segment;try{name=decodeURIComponent(segment);}catch{/* Keep malformed display names usable. */}
  return name.replace(/\.[a-z0-9]{1,5}$/i,'')||name;
}
