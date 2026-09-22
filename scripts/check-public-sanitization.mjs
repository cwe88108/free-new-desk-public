import { readdir,readFile } from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const skip=new Set(['.git','node_modules','dist','.packaging','build','coverage']);
const privateRepo=['cwe88108','free-new-desk'].join('/');
const publicRepo=privateRepo+'-public';
const forbidden=[privateRepo,'D:'+String.raw`\\workbuddy\\free-new-desk\\free-new-desk-V1.4.16-57f0f2e`,'C:'+String.raw`\\Users\\cwe88`,'cwe8810888'+'@gmail.com','chen'+'yz'];
const textExtensions=new Set(['.md','.mjs','.cjs','.js','.ts','.cts','.mts','.vue','.json','.yml','.yaml','.ps1','.cpp','.h','.hpp','.cmake','.txt']);
const violations=[];

async function inspect(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(entry.isDirectory()){if(!skip.has(entry.name))await inspect(path.join(directory,entry.name));continue;}
    const file=path.join(directory,entry.name);
    if(!textExtensions.has(path.extname(entry.name))&&!['LICENSE','README.md'].includes(entry.name))continue;
    const value=await readFile(file,'utf8');
    for(const needle of forbidden){
      let offset=value.indexOf(needle);
      while(offset>=0){
        const publicReference=needle===privateRepo&&value.slice(offset,offset+publicRepo.length)===publicRepo;
        if(!publicReference)violations.push(`${path.relative(root,file)} contains a private reference`);
        offset=value.indexOf(needle,offset+needle.length);
      }
    }
  }
}

const manifest=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
if(manifest.private===true)violations.push('package.json still marks this package private');
if(manifest.build?.appId!=='org.free-new-desk.desktop')violations.push('package.json does not use the public application identifier');
await inspect(root);
if(violations.length)throw new Error(`Public sanitization failed:\n${violations.join('\n')}`);
console.log('Public sanitization passed.');
