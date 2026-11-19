import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';

export async function prepareMpvRuntime(root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')){
const runtimeDir=path.join(root,'third_party','mpv','win-x64');
const sourceFile=path.join(runtimeDir,'SOURCE.txt');
const target=path.join(runtimeDir,'libmpv-2.dll');
const sourceText=await readFile(sourceFile,'utf8');
const field=name=>sourceText.match(new RegExp(`^${name}:\\s*(.+)$`,'mi'))?.[1]?.trim();
const vendoredName=field('vendored archive');
if(vendoredName&&!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.7z$/.test(vendoredName))throw new Error('Invalid vendored archive filename');
const source=field('source'),archiveSha=field('archive sha256')?.toLowerCase(),dllSha=field('dll sha256')?.toLowerCase();
if(!source||!/^https:\/\//i.test(source)||!/^[a-f0-9]{64}$/.test(archiveSha??'')||!/^[a-f0-9]{64}$/.test(dllSha??''))throw new Error('SOURCE.txt must declare HTTPS source, archive sha256 and dll sha256');
const hash=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
const exists=async file=>access(file).then(()=>true,()=>false);
if(await exists(target)){
  const actual=await hash(target);
  if(actual!==dllSha)throw new Error(`Existing libmpv-2.dll SHA256 mismatch: ${actual}`);
  console.log(`Validated libmpv-2.dll SHA256 ${actual}`);
  return;
}

await mkdir(runtimeDir,{recursive:true});
const work=await mkdtemp(path.join(tmpdir(),'free-new-desk-mpv-'));
const archive=path.join(work,'mpv-runtime.7z');
const cacheDir=path.join(root,'third_party','mpv','cache'),cachedArchive=path.join(cacheDir,`${archiveSha}.7z`);
try{
  if(vendoredName){
    // The provider retains rolling builds for only 30 days. A pinned checkout
    // must remain buildable without the network or an Actions cache.
    await copyFile(path.join(root,'third_party','mpv','vendor',vendoredName),archive);
  }else if(await exists(cachedArchive))await copyFile(cachedArchive,archive);
  else{
    console.log(`Downloading pinned mpv runtime: ${source}`);
    const response=await fetch(source,{redirect:'follow',signal:AbortSignal.timeout(120_000)});
    if(!response.ok||!response.body)throw new Error(`mpv download failed: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body),createWriteStream(archive));
  }
  const actualArchive=await hash(archive);
  if(actualArchive!==archiveSha)throw new Error(`mpv archive SHA256 mismatch: ${actualArchive}`);
  const extracted=path.join(work,'extracted');
  await mkdir(extracted,{recursive:true});
  // Windows' bundled bsdtar reads 7z; no transitive npm archiver binary is needed.
  if(process.platform!=='win32')throw new Error('Preparing the Windows mpv runtime requires Windows bsdtar');
  execFileSync(path.join(process.env.SystemRoot||'C:\\Windows','System32','tar.exe'),['-xf',archive,'-C',extracted],{stdio:'inherit',windowsHide:true});
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
  const actualDll=await hash(found);
  if(actualDll!==dllSha)throw new Error(`Extracted libmpv-2.dll SHA256 mismatch: ${actualDll}`);
  await mkdir(cacheDir,{recursive:true});await copyFile(archive,cachedArchive);
  await copyFile(found,target);
  console.log(`Prepared pinned libmpv-2.dll SHA256 ${actualDll}`);
}finally{
  await rm(work,{recursive:true,force:true});
}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await prepareMpvRuntime();
