import {open} from 'node:fs/promises';

/** Bound allocation even when a selected file grows after the initial stat. */
export async function readImportFile(filePath:string,maxBytes:number,limitMessage:string):Promise<Buffer>{
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw new Error('Invalid import size limit');
  const file=await open(filePath,'r');
  try{
    const info=await file.stat();
    if(!info.isFile())throw new Error('请选择普通配置文件或播放列表文件');
    if(info.size>maxBytes)throw new Error(limitMessage);
    const chunks:Buffer[]=[];
    let total=0;
    for(;;){
      const buffer=Buffer.allocUnsafe(Math.min(64*1024,maxBytes-total+1));
      const {bytesRead}=await file.read(buffer,0,buffer.length,null);
      if(bytesRead===0)break;
      total+=bytesRead;
      if(total>maxBytes)throw new Error(limitMessage);
      chunks.push(buffer.subarray(0,bytesRead));
    }
    return Buffer.concat(chunks,total);
  }finally{await file.close();}
}
