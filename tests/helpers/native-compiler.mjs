import {spawnSync} from 'node:child_process';
import path from 'node:path';

// MSVC needs a Developer Shell environment; CXX selects it explicitly.
export function runNativeCompiler(compiler,args,options={}){
  if(!/^cl(?:\.exe)?$/i.test(path.basename(compiler)))return spawnSync(compiler,args,options);
  if(args.length===1&&args[0]==='--version')return spawnSync(compiler,['/?'],options);
  const translated=['/nologo','/EHsc','/utf-8'];let output;
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg.startsWith('-std=c++'))translated.push('/std:'+arg.slice(5));
    else if(arg==='-pthread')continue; // MSVC's standard library supplies threading.
    else if(arg==='-I')translated.push('/I'+args[++i]);
    else if(arg==='-o'){output=args[++i];translated.push('/Fe:'+output);}
    else translated.push(arg);
  }
  if(output)translated.push('/Fo:'+path.join(path.dirname(output),'test.obj'));
  return spawnSync(compiler,translated,{...options,...(output?{cwd:path.dirname(output)}:{})});
}
