import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const stagingRoot=path.join(root,'.packaging','runtime-node-modules');
const workspaceRoots=['packages','services'];
const staged=[];

async function exists(target){try{await stat(target);return true;}catch{return false;}}
async function readJson(target){return JSON.parse(await readFile(target,'utf8'));}

await rm(path.join(root,'.packaging'),{recursive:true,force:true});
await mkdir(stagingRoot,{recursive:true});

for(const workspaceRoot of workspaceRoots){
  const base=path.join(root,workspaceRoot);
  for(const entry of await readdir(base,{withFileTypes:true})){
    if(!entry.isDirectory())continue;
    const workspace=path.join(base,entry.name);
    const manifestPath=path.join(workspace,'package.json');
    if(!await exists(manifestPath))continue;
    const manifest=await readJson(manifestPath);
    if(typeof manifest.name!=='string'||!manifest.name.startsWith('@free-new-desk/'))continue;
    const dist=path.join(workspace,'dist');
    if(!await exists(dist))continue;
    const [scope,name]=manifest.name.split('/');
    if(!scope||!name)throw new Error(`Invalid workspace package name: ${manifest.name}`);
    const target=path.join(stagingRoot,scope,name);
    await mkdir(target,{recursive:true});
    await cp(dist,path.join(target,'dist'),{recursive:true});
    await cp(manifestPath,path.join(target,'package.json'));
    staged.push({name:manifest.name,version:String(manifest.version??'0.0.0'),source:path.relative(root,workspace)});
  }
}

const required=new Set();
async function scan(directory){
  if(!await exists(directory))return;
  for(const entry of await readdir(directory,{withFileTypes:true})){
    const target=path.join(directory,entry.name);
    if(entry.isDirectory()){await scan(target);continue;}
    if(!/\.(?:c?js|mjs)$/.test(entry.name))continue;
    const content=await readFile(target,'utf8');
    for(const match of content.matchAll(/["'](@free-new-desk\/[A-Za-z0-9._-]+)["']/g))required.add(match[1]);
  }
}
await scan(path.join(root,'apps','desktop','dist','main'));
await scan(path.join(root,'services'));
await scan(path.join(root,'packages'));

const stagedNames=new Set(staged.map(item=>item.name));
const missing=[...required].filter(name=>!stagedNames.has(name));
if(missing.length)throw new Error(`Runtime staging is missing workspace packages: ${missing.join(', ')}`);
if(!stagedNames.has('@free-new-desk/contracts'))throw new Error('Runtime staging did not include @free-new-desk/contracts');

const report={generatedAt:new Date().toISOString(),node:process.version,packages:staged.sort((a,b)=>a.name.localeCompare(b.name)),requiredImports:[...required].sort()};
await writeFile(path.join(root,'.packaging','runtime-workspaces.json'),`${JSON.stringify(report,null,2)}\n`,'utf8');
console.log(`Staged ${staged.length} internal runtime workspaces for Electron packaging.`);
for(const item of report.packages)console.log(`  ${item.name}@${item.version} <- ${item.source}`);
