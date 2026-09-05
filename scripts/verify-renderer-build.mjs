import { readFile,readdir } from 'node:fs/promises';
import path from 'node:path';

const root=process.cwd();
const renderer=path.join(root,'apps','desktop','dist','renderer');
const html=await readFile(path.join(renderer,'index.html'),'utf8');
if(/(?:src|href)=["']\/assets\//i.test(html))throw new Error('Renderer build contains absolute /assets paths and will fail under file:// packaging.');
if(!/(?:src|href)=["']\.\/assets\//i.test(html))throw new Error('Renderer build does not contain relative ./assets references.');
const assets=await readdir(path.join(renderer,'assets'));
if(!assets.some(name=>name.endsWith('.js')))throw new Error('Renderer build has no JavaScript asset.');
if(!assets.some(name=>name.endsWith('.css')))throw new Error('Renderer build has no CSS asset.');
console.log(`Renderer package paths verified: ${assets.length} assets, relative file:// references only.`);
