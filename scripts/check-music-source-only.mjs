import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { parse } from '@vue/compiler-sfc';
const root=process.cwd();
let errors=0;
for(const config of ['apps/desktop/tsconfig.main.json','apps/desktop/tsconfig.preload.json']){
 const raw=ts.readConfigFile(config,ts.sys.readFile);
 const parsed=ts.parseJsonConfigFileContent(raw.config,ts.sys,path.dirname(path.resolve(config)));
 const options={...parsed.options,noEmit:true,incremental:false,rootDir:root,baseUrl:root,paths:{'@free-new-desk/contracts':['packages/contracts/src/index.ts']}};
 const program=ts.createProgram(parsed.fileNames,options);
 const diagnostics=ts.getPreEmitDiagnostics(program);
 for(const d of diagnostics){console.log(ts.flattenDiagnosticMessageText(d.messageText,'\n'),d.file?.fileName,d.start);errors++;}
}
for(const file of ['MusicView.vue','../components/MusicNetworkSourceDialog.vue','../components/MusicArtwork.vue','../components/MusicIcon.vue']){
 const name=path.resolve('apps/desktop/src/renderer/views',file),result=parse(fs.readFileSync(name,'utf8'),{filename:name});
 for(const error of result.errors){console.log(name,error);errors++;}
}
console.log(JSON.stringify({mode:'source-only-no-emit',errors}));process.exitCode=errors?1:0;
