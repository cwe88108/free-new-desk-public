export function decodeMusicLyrics(bytes:Uint8Array):string{
  if(bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder('utf-16le').decode(bytes).replace(/^\uFEFF/,'');
  if(bytes[0]===0xfe&&bytes[1]===0xff)return new TextDecoder('utf-16be').decode(bytes).replace(/^\uFEFF/,'');
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');}catch{return new TextDecoder('gb18030').decode(bytes).replace(/^\uFEFF/,'');}
}
