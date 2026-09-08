import { execFileSync } from 'node:child_process';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const assetsDir=path.resolve('assets'),pngPath=path.join(assetsDir,'app-icon.png'),icoPath=path.join(assetsDir,'app-icon.ico');
const sizes=[16,20,24,32,48,64,128,256],pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
function pngSize(bytes){if(bytes.length<24||!bytes.subarray(0,8).equals(pngSignature))throw new Error('assets/app-icon.png 不是有效 PNG');return{width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};}
function makeIco(images){const header=Buffer.alloc(6+16*images.length);header.writeUInt16LE(0,0);header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);let offset=header.length;images.forEach(({size,bytes},i)=>{const p=6+i*16;header[p]=size>=256?0:size;header[p+1]=size>=256?0:size;header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(bytes.length,p+8);header.writeUInt32LE(offset,p+12);offset+=bytes.length;});return Buffer.concat([header,...images.map(v=>v.bytes)]);}
const source=await readFile(pngPath),dim=pngSize(source);if(dim.width<256||dim.height<256)throw new Error(`应用图标分辨率过低：${dim.width}x${dim.height}，至少需要 256x256`);
const temp=await mkdtemp(path.join(os.tmpdir(),'fnd-icon-'));
try{
  const ps=`Add-Type -AssemblyName System.Drawing;$src=[Drawing.Image]::FromFile($env:FND_ICON_SRC);${sizes.map(s=>`$b=New-Object Drawing.Bitmap(${s},${s},[Drawing.Imaging.PixelFormat]::Format32bppArgb);$g=[Drawing.Graphics]::FromImage($b);$g.Clear([Drawing.Color]::FromArgb(255,245,245,245));$g.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;$g.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::HighQuality;$g.DrawImage($src,0,0,${s},${s});$g.Dispose();$b.Save((Join-Path $env:FND_ICON_OUT '${s}.png'),[Drawing.Imaging.ImageFormat]::Png);$b.Dispose();`).join('')}$src.Dispose();`;
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{stdio:'inherit',env:{...process.env,FND_ICON_SRC:pngPath,FND_ICON_OUT:temp}});
  const images=[];for(const size of sizes)images.push({size,bytes:await readFile(path.join(temp,`${size}.png`))});
  await writeFile(icoPath,makeIco(images));
  console.log(`Validated requested Free New Desk artwork ${dim.width}x${dim.height}; materialized opaque multi-size ICO (${sizes.join(',')}) without redrawing the supplied icon.`);
}finally{await rm(temp,{recursive:true,force:true});}
