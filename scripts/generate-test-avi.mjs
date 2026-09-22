import fs from 'node:fs';
const [output,widthArg='160',heightArg='90',fpsArg='25',secondsArg='12']=process.argv.slice(2);
if(!output)throw new Error('Usage: node generate-test-avi.mjs <output> [width] [height] [fps] [seconds]');
const width=Number(widthArg),height=Number(heightArg),fps=Number(fpsArg),seconds=Number(secondsArg),frames=Math.ceil(Number(fpsArg)*Number(secondsArg));
if(!Number.isInteger(width)||!Number.isInteger(height)||!Number.isInteger(fps)||!Number.isFinite(seconds)||width<16||height<16||fps<1||seconds<=0)throw new Error('Invalid AVI dimensions or duration');
const four=value=>Buffer.from(value,'ascii');
const u32=value=>{const b=Buffer.alloc(4);b.writeUInt32LE(value>>>0);return b;};
const chunk=(id,data)=>Buffer.concat([four(id),u32(data.length),data,...(data.length%2?[Buffer.from([0])]:[])]);
const list=(type,...children)=>chunk('LIST',Buffer.concat([four(type),...children]));
const frameSize=width*height*3,usPerFrame=Math.round(1_000_000/fps);
const u16=value=>{const b=Buffer.alloc(2);b.writeUInt16LE(value>>>0);return b;};
const i16=value=>{const b=Buffer.alloc(2);b.writeInt16LE(value);return b;};
const i32=value=>{const b=Buffer.alloc(4);b.writeInt32LE(value);return b;};
const avih=Buffer.concat([u32(usPerFrame),u32(frameSize*fps),u32(0),u32(0x10),u32(frames),u32(0),u32(1),u32(frameSize),u32(width),u32(height),u32(0),u32(0),u32(0),u32(0)]);
const strh=Buffer.concat([four('vids'),four('DIB '),u32(0),u16(0),u16(0),u32(0),u32(1),u32(fps),u32(0),u32(frames),u32(frameSize),u32(0xffffffff),u32(frameSize),i16(0),i16(0),i16(width),i16(height)]);
const strf=Buffer.concat([u32(40),i32(width),i32(height),u16(1),u16(24),u32(0),u32(frameSize),i32(0),i32(0),u32(0),u32(0)]);
const hdrl=list('hdrl',chunk('avih',avih),list('strl',chunk('strh',strh),chunk('strf',strf)));
const frameChunks=[],indexEntries=[];let offset=4;
for(let i=0;i<frames;i++){
 const data=Buffer.alloc(frameSize);const shade=(i*7)%220+16;
 for(let p=0;p<frameSize;p+=3){data[p]=shade;data[p+1]=(shade+40)%256;data[p+2]=(shade+80)%256;}
 const c=chunk('00db',data);frameChunks.push(c);
 indexEntries.push(Buffer.concat([four('00db'),u32(0x10),u32(offset),u32(frameSize)]));offset+=c.length;
}
const movi=list('movi',...frameChunks),idx1=chunk('idx1',Buffer.concat(indexEntries));
const body=Buffer.concat([four('AVI '),hdrl,movi,idx1]);
fs.writeFileSync(output,Buffer.concat([four('RIFF'),u32(body.length),body]));
console.log(JSON.stringify({output,width,height,fps,seconds,frames,bytes:fs.statSync(output).size}));
