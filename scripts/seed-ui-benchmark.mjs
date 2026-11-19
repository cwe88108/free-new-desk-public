import {mkdir,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const[rootArg,profileArg,countArg='712']=process.argv.slice(2);
const root=path.resolve(rootArg),profile=path.resolve(profileArg),count=Number(countArg);
if(!Number.isSafeInteger(count)||count<0||count>2000)throw Error('Invalid fixture source count');
try{await stat(profile);throw Error('Refusing existing benchmark profile');}catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(path.join(profile,'data'),{recursive:true});
const{DataService}=await import(pathToFileURL(path.join(root,'services/data-service/dist/index.js')).href);
const store=new DataService(path.join(profile,'data/app.db'));
try{
  store.setSetting('theme','light');store.setSetting('update.schedule','off');
  for(let index=0;index<count;index++)store.saveSource({id:'benchmark-'+index,name:'基准来源 '+String(index+1).padStart(4,'0'),kind:'T1_JSON',endpoint:'https://example.invalid/benchmark/'+index,enabled:false,trust:'A',searchable:true});
}finally{store.close();}
await writeFile(path.join(profile,'benchmark-fixture.json'),JSON.stringify({schemaVersion:1,sourceCount:count,enabledSourceCount:0,thirdPartyCode:false,theme:'light',note:'Synthetic UI workload; does not prove real source compatibility.'},null,2));
