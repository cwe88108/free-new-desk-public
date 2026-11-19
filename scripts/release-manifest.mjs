import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFile,writeFile,readdir,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {rootCertificates} from 'node:tls';
import {prepareBuilderTools} from './prepare-builder-tools.mjs';

const digest=(bytes,algorithm='sha256')=>createHash(algorithm).update(bytes).digest(algorithm==='sha512'?'base64':'hex');
const playerTrustBundle=rootCertificates.join('\n')+'\n';
const require=createRequire(import.meta.url);
const yaml=require('js-yaml');
async function fileHash(file){const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');}
// Signing changes only the PE checksum, certificate directory and appended certificate. Compare every other byte.
export function executableImageHash(bytes){
  const pe=bytes.length>=64?bytes.readUInt32LE(0x3c):0;
  if(bytes.toString('ascii',0,2)!=='MZ'||pe<64||pe+24>bytes.length||bytes.toString('ascii',pe,pe+4)!=='PE\0\0')throw new Error('Invalid native PE executable');
  const optional=pe+24,magic=bytes.readUInt16LE(optional),checksum=optional+64,security=optional+(magic===0x20b?112:magic===0x10b?96:0)+32;
  if(![0x20b,0x10b].includes(magic)||security+8>bytes.length)throw new Error('Invalid native PE optional header');
  const offset=bytes.readUInt32LE(security),size=bytes.readUInt32LE(security+4);
  if((offset===0)!==(size===0)||offset&&(offset<security+8||offset%8||offset+size!==bytes.length))throw new Error('Native PE certificate table has an unsupported layout');
  const image=Buffer.from(bytes.subarray(0,offset||bytes.length));image.fill(0,checksum,checksum+4);image.fill(0,security,security+8);
  return digest(image);
}
async function inventory(directory,prefix=''){
  const files=[];
  for(const entry of await readdir(path.join(directory,prefix),{withFileTypes:true})){
    const relative=path.posix.join(prefix,entry.name);
    if(entry.isDirectory())files.push(...await inventory(directory,relative));
    else if(entry.isFile())files.push({path:relative,sha256:await fileHash(path.join(directory,relative))});
    else throw new Error(`Release payload contains a link or special file: ${relative}`);
  }
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}
export function validateUpdateManifest(text,setup,version){
  const update=yaml.load(text);
  if(update?.version!==version)throw new Error('latest.yml version does not match package.json');
  if(update.path!==setup.name||update.sha512!==setup.sha512||!Array.isArray(update.files)||update.files.length!==1||update.files[0].url!==setup.name||update.files[0].sha512!==setup.sha512||update.files[0].size!==setup.size)throw new Error('latest.yml installer path, URL, size or SHA512 does not match the final artifact');
}
function extractArchive(tool,archive,output){
  const listing=execFileSync(tool,['l','-slt','--',archive],{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
  const entries=listing.split(/\r?\n-{5,}\r?\n/).slice(1).join('\n');
  if(!entries)throw new Error('Release archive did not expose a file inventory');
  for(const match of entries.matchAll(/^Path = (.+)$/gm)){
    if(/^(?:[\\/]|[a-z]:)|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(match[1]))throw new Error('Unsafe path in release archive');
  }
  execFileSync(tool,['x','-y','-bso0','-bsp0',`-o${output}`,'--',archive],{windowsHide:true});
}
export async function verifyExecutablePayload(file,expected,releaseDir){
  const tool=(await prepareBuilderTools(undefined,{nsis:false})).sevenZipPath;
  const temporary=await mkdtemp(path.join(releaseDir,'.verify-payload-'));
  try{
    const outer=path.join(temporary,'outer');
    await mkdir(outer);
    extractArchive(tool,file,outer);
    async function find(directory){const found=[];for(const entry of await readdir(directory,{withFileTypes:true})){const target=path.join(directory,entry.name);if(entry.isDirectory())found.push(...await find(target));else if(/^app-64\.(?:7z|zip)$/.test(entry.name))found.push(target);}return found;}
    const archives=await find(outer);
    if(archives.length>0){
      // Native NSIS wrapping is not the supported append-7z layout. Reject it rather than silently omitting wrapper files.
      throw new Error('Release executable wrapper layout is not supported for complete payload verification');
    }
    // 7za exposes the appended application 7z directly, without the NSIS wrapper.
    const actual=await inventory(outer);
    if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`Release payload does not match the current unpacked application: ${path.basename(file)}`);
    return{fileCount:actual.length,treeSha256:digest(Buffer.from(JSON.stringify(actual)))};
  }finally{await rm(temporary,{recursive:true,force:true});}
}
function signature(file){
  const script='$ErrorActionPreference="Stop"; $s=Get-AuthenticodeSignature -LiteralPath $env:FND_SIGNATURE_FILE; @{status=$s.Status.ToString();publisher=$s.SignerCertificate.Subject;thumbprint=$s.SignerCertificate.Thumbprint;timestamped=($null -ne $s.TimeStamperCertificate)}|ConvertTo-Json -Compress';
  try{
    return JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,env:{...process.env,FND_SIGNATURE_FILE:file}}));
  }catch(error){
    // PowerShell 7 is not part of the Windows base image. Unsigned builds must still produce a
    // manifest, so report the inspector as unavailable; signed gates still fail in assertPublisher.
    if(error?.code==='ENOENT')return{status:'Unavailable',reason:'pwsh.exe not found'};
    throw error;
  }
}
function assertPublisher(name,authenticode,expectedSigner){
  if(authenticode.status!=='Valid'||!authenticode.timestamped)throw new Error(`Signed release rejected: ${name} requires a valid timestamped publisher signature${authenticode.reason?` (${authenticode.reason})`:''}`);
  if(authenticode.thumbprint?.toUpperCase()!==expectedSigner)throw new Error(`Signed release rejected: ${name} publisher certificate does not match FND_SIGNER_THUMBPRINT`);
}
export async function sourceProvenance(root){
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const buildTools=JSON.parse(await readFile(path.join(root,'third_party/build-tools/SOURCE.json'),'utf8'));
  const files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root}).toString().split('\0').filter(Boolean).sort();
  const tree=createHash('sha256');
  for(const file of files){tree.update(file+'\0');try{tree.update(await readFile(path.join(root,file)));}catch(error){if(error.code!=='ENOENT')throw error;tree.update('deleted');}tree.update('\0');}
  const mpvSource=await readFile(path.join(root,'third_party','mpv','win-x64','SOURCE.txt'),'utf8');
  const java=spawnSync('java',['-version'],{encoding:'utf8',windowsHide:true});
  if(java.status!==0)throw new Error('Cannot record Java build runtime');
  return{schemaVersion:1,version:pkg.version,
    buildTools:{electronBuilder:pkg.devDependencies['electron-builder'],sevenZip:buildTools.sevenZip.version,nsis:buildTools.nsis.version,nsisToolset:buildTools.nsis.toolset,sevenZipWinSha256:buildTools.sevenZip.platforms['win32-x64'].executableSha256,nsisBundleSha256:buildTools.nsis.archiveSha256},
    source:{commit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirty:Boolean(execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim()),treeSha256:tree.digest('hex'),lockSha256:digest(await readFile(path.join(root,'package-lock.json')))},
    runtimes:{buildNode:process.version,electron:pkg.devDependencies.electron,mpvCommit:/^mpv commit:\s*(.+)$/m.exec(mpvSource)?.[1]?.trim(),mpvDllSha256:await fileHash(path.join(root,'third_party/mpv/win-x64/libmpv-2.dll')),playerTrustBundleSha256:digest(playerTrustBundle),java:(java.stderr||java.stdout).trim().split(/\r?\n/)[0]},
    nativeBuild:{playerHostSha256:await fileHash(path.join(root,'native/player-host/build/Release/player-host.exe')),smbHelperSha256:await fileHash(path.join(root,'native/player-host/build/Release/smb-helper.exe')),playerHostImageSha256:executableImageHash(await readFile(path.join(root,'native/player-host/build/Release/player-host.exe'))),smbHelperImageSha256:executableImageHash(await readFile(path.join(root,'native/player-host/build/Release/smb-helper.exe')))}};
}
export async function prepareReleaseProvenance(root){
  // Run only after native binaries, mpv, and the dependency tree have been prepared.
  // A clean CI build must create the exact file electron-builder embeds in app.asar.
  const provenance=await sourceProvenance(root);
  const target=path.join(root,'dist','build-provenance.json');
  await mkdir(path.dirname(target),{recursive:true});
  await writeFile(path.join(root,'dist','player-public-roots.pem'),playerTrustBundle,'utf8');
  await writeFile(target,JSON.stringify(provenance,null,2)+'\n','utf8');
  console.log(`Prepared build provenance before packaging: ${target}`);
  return provenance;
}
export async function writeReleaseManifest(root,requireSignature=false){
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const releaseDir=path.resolve(root,process.env.FND_RELEASE_DIR||pkg.build.directories.output);
  if(!releaseDir.startsWith(path.resolve(root)+path.sep))throw new Error('Release output must stay inside the project');
  const expectedSigner=(process.env.FND_SIGNER_THUMBPRINT||'').replace(/\s/g,'').toUpperCase();
  if(requireSignature&&!/^[0-9A-F]{40}$/.test(expectedSigner))throw new Error('Signed release requires FND_SIGNER_THUMBPRINT for the expected publisher certificate');
  const assets=[];
  for(const kind of ['Setup','Portable']){
    const name=`Free-New-Desk-${kind}-${pkg.version}-x64.exe`,file=path.join(releaseDir,name),bytes=await readFile(file);
    const authenticode=process.platform==='win32'?signature(file):{status:'Unavailable'};
    if(requireSignature)assertPublisher(name,authenticode,expectedSigner);
    assets.push({name,size:bytes.length,sha256:digest(bytes),sha512:digest(bytes,'sha512'),authenticode});
  }
  if(requireSignature&&new Set(assets.map(asset=>asset.authenticode.thumbprint)).size!==1)throw new Error('Installer and portable publisher certificates differ');
  validateUpdateManifest(await readFile(path.join(releaseDir,'latest.yml'),'utf8'),assets[0],pkg.version);
  const provenance=await sourceProvenance(root);
  const asar=require('@electron/asar');
  let embedded;
  try{embedded=JSON.parse(asar.extractFile(path.join(releaseDir,'win-unpacked','resources','app.asar'),'build-provenance.json'));}
  catch(error){throw new Error('Missing or malformed embedded build-provenance.json; generate provenance BEFORE electron-builder packs app.asar',{cause:error});}
  if(JSON.stringify(embedded)!==JSON.stringify(provenance))throw new Error('Packaged provenance differs from the current source/runtime; rebuild before producing a release manifest');
  const nativeDir=path.join(releaseDir,'win-unpacked/resources/native/player-host'),nativeFiles=[];
  for(const[name,expected]of [['player-host.exe',provenance.nativeBuild.playerHostImageSha256],['smb-helper.exe',provenance.nativeBuild.smbHelperImageSha256],['libmpv-2.dll',provenance.runtimes.mpvDllSha256],['player-public-roots.pem',provenance.runtimes.playerTrustBundleSha256]]){
    const file=path.join(nativeDir,name),bytes=await readFile(file),imageSha256=name.endsWith('.exe')?executableImageHash(bytes):digest(bytes);
    if(imageSha256!==expected)throw new Error(`Packaged native file differs from the current build: ${name}`);
    const authenticode=name.endsWith('.exe')&&process.platform==='win32'?signature(file):undefined;
    if(requireSignature&&name.endsWith('.exe'))assertPublisher(name,authenticode,expectedSigner);
    nativeFiles.push({name,sha256:digest(bytes),imageSha256,...(authenticode?{authenticode}:{})});
  }
  const expected=await inventory(path.join(releaseDir,'win-unpacked'));
  for(const asset of assets)asset.payload=await verifyExecutablePayload(path.join(releaseDir,asset.name),expected,releaseDir);
  const runtimeEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>['systemroot','windir','path','temp','tmp'].includes(key.toLowerCase())));
  if(requireSignature)assertPublisher('Free New Desk.exe',signature(path.join(releaseDir,'win-unpacked','Free New Desk.exe')),expectedSigner);
  const bundledRuntime=JSON.parse(execFileSync(path.join(releaseDir,'win-unpacked','Free New Desk.exe'),['-p','JSON.stringify(process.versions)'],{encoding:'utf8',windowsHide:true,timeout:15_000,env:{...runtimeEnv,ELECTRON_RUN_AS_NODE:'1'}}));
  if(bundledRuntime.electron!==pkg.devDependencies.electron)throw new Error('Packaged Electron runtime does not match the pinned dependency');
  const manifest={...provenance,generatedAt:new Date().toISOString(),signed:requireSignature,bundledRuntime,nativeFiles,assets};
  await writeFile(path.join(releaseDir,'release-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  await writeFile(path.join(releaseDir,'SHA256SUMS.txt'),assets.map(asset=>`${asset.sha256}  ${asset.name}`).join('\n')+'\n');
  console.log(`Validated ${pkg.version}: ${assets.length} artifacts, installer SHA512 and ${requireSignature?'timestamped signatures':'signature status'} recorded.`);
  return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const root=fileURLToPath(new URL('../',import.meta.url));
  if(process.argv.includes('--prepare'))await prepareReleaseProvenance(root);
  else await writeReleaseManifest(root,process.argv.includes('--signed'));
}
