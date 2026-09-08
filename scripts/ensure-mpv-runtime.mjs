import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const runtimeDir=path.join(root,'third_party','mpv','win-x64');
const sourceFile=path.join(runtimeDir,'SOURCE.txt');
const target=path.join(runtimeDir,'libmpv-2.dll');
const sourceText=await readFile(sourceFile,'utf8');
const field=name=>sourceText.match(new RegExp(`^${name}:\\s*(.+)$`,'mi'))?.[1]?.trim();
const source=field('source'),archiveSha=field('archive sha256')?.toLowerCase(),dllSha=field('dll sha256')?.toLowerCase();
if(!source||!archiveSha||!dllSha)throw new Error('SOURCE.txt must declare source, archive sha256 and dll sha256');
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const exists=async file=>access(file).then(()=>true,()=>false);
if(await exists(target)){
  const actual=await hash(target);
  if(actual!==dllSha)throw new Error(`Existing libmpv-2.dll SHA256 mismatch: ${actual}`);
  console.log(`Validated libmpv-2.dll SHA256 ${actual}`);
  process.exit(0);
}

await mkdir(runtimeDir,{recursive:true});
const work=await mkdtemp(path.join(tmpdir(),'free-new-desk-mpv-'));
const archive=path.join(work,'mpv-runtime.7z');
try{
  console.log(`Downloading pinned mpv runtime: ${source}`);
  const response=await fetch(source,{redirect:'follow'});
  if(!response.ok||!response.body)throw new Error(`mpv download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body),createWriteStream(archive));
  const actualArchive=await hash(archive);
  if(actualArchive!==archiveSha)throw new Error(`mpv archive SHA256 mismatch: ${actualArchive}`);
  const sevenZip=path.join(root,'node_modules','7zip-bin','win','x64','7za.exe');
  if(!(await exists(sevenZip)))throw new Error(`7za.exe not found: ${sevenZip}`);
  const extracted=path.join(work,'extracted');
  await mkdir(extracted,{recursive:true});
  execFileSync(sevenZip,['x','-y',`-o${extracted}`,archive],{stdio:'inherit'});
  const find=async dir=>{
    for(const entry of await readdir(dir,{withFileTypes:true})){
      const full=path.join(dir,entry.name);
      if(entry.isDirectory()){
        const nested=await find(full);if(nested)return nested;
      }else if(entry.name.toLowerCase()==='libmpv-2.dll')return full;
    }
  };
  const found=await find(extracted);
  if(!found)throw new Error('Downloaded mpv archive does not contain libmpv-2.dll');
  await copyFile(found,target);
  const actualDll=await hash(target);
  if(actualDll!==dllSha)throw new Error(`Extracted libmpv-2.dll SHA256 mismatch: ${actualDll}`);
  console.log(`Prepared pinned libmpv-2.dll SHA256 ${actualDll}`);
}finally{
  await rm(work,{recursive:true,force:true});
}
