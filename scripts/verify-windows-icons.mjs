import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function verifyWindowsIcons(executables,iconFile){
  const ico=await readFile(iconFile);
  if(ico.readUInt16LE(2)!==1)throw Error('Expected ICO file');
  const expected=new Set(Array.from({length:ico.readUInt16LE(4)},(_,i)=>{const at=6+i*16;return hash(ico.subarray(ico.readUInt32LE(at+12),ico.readUInt32LE(at+12)+ico.readUInt32LE(at+8)));}));
  const reports=[];
  for(const file of executables){
    const bytes=await readFile(file),pe=bytes.readUInt32LE(0x3c),optional=pe+24;
    if(bytes.toString('ascii',pe,pe+4)!=='PE\0\0')throw Error('Invalid PE executable: '+file);
    const data=optional+(bytes.readUInt16LE(optional)===0x20b?112:96),sections=optional+bytes.readUInt16LE(pe+20);
    const offset=rva=>{for(let i=0;i<bytes.readUInt16LE(pe+6);i++){const s=sections+i*40,start=bytes.readUInt32LE(s+12),size=Math.max(bytes.readUInt32LE(s+8),bytes.readUInt32LE(s+16));if(rva>=start&&rva<start+size)return bytes.readUInt32LE(s+20)+rva-start;}throw Error('Resource RVA outside PE sections');};
    const resource=offset(bytes.readUInt32LE(data+16)),leaves=[];
    function visit(relative,ids=[]){
      if(ids.length>3)throw Error('Unexpected PE resource depth');
      const at=resource+relative,count=bytes.readUInt16LE(at+12)+bytes.readUInt16LE(at+14);
      for(let i=0;i<count;i++){const item=at+16+i*8,id=bytes.readUInt32LE(item),value=bytes.readUInt32LE(item+4);if(value&0x80000000)visit(value&0x7fffffff,[...ids,id]);else{const entry=resource+value,start=offset(bytes.readUInt32LE(entry));leaves.push({ids:[...ids,id],data:bytes.subarray(start,start+bytes.readUInt32LE(entry+4))});}}
    }
    visit(0);
    const icons=new Map(leaves.filter(x=>x.ids[0]===3).map(x=>[x.ids[1],hash(x.data)]));
    const groups=leaves.filter(x=>x.ids[0]===14).map(x=>Array.from({length:x.data.readUInt16LE(4)},(_,i)=>icons.get(x.data.readUInt16LE(6+i*14+12))));
    const matching=groups.find(values=>values.length>=1&&values.every(value=>expected.has(value)));
    if(!matching)throw Error('Project icon missing or replaced in '+file);
    reports.push({file:path.basename(file),matchingImages:matching.length,iconSha256:hash(ico),passed:true});
  }
  return reports;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=fileURLToPath(new URL('../',import.meta.url));
  console.log(JSON.stringify(await verifyWindowsIcons(process.argv.slice(2),path.join(root,'assets/app-icon.ico')),null,2));
}
