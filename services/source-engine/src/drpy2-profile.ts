import type { DrpyEngineManifest } from './drpy-engine-manager.js';

export const DRPY2_HOST_ABI_VERSION='fnd-drpy2-host/2';
export interface Drpy2Profile{
  id:string;
  hostAbiVersion:string;
  engineSha256:string;
  dependencies:Record<string,string>;
  methods:{home:string;homeVod:string;category:string;detail:string;search:string;play:string};
}

const qistDrpy2_3952:Drpy2Profile={
  id:'qist-drpy2-3.9.52beta3-20250801',
  hostAbiVersion:DRPY2_HOST_ABI_VERSION,
  engineSha256:'67f4f6b460db1ec7ef50585953ce826c5263ca91d72958490ef4702b4e154fe1',
  dependencies:{'drpy-core-lite.min.js':'18bab373dfa67a4956f25f273fafb3e5b6b9fdf7bafb21acf0f6264b474900f5'},
  methods:{home:'home',homeVod:'homeVod',category:'category',detail:'detail',search:'search',play:'play'},
};

export function resolveDrpy2Profile(manifest:DrpyEngineManifest):Drpy2Profile{
  const profile=qistDrpy2_3952;if(manifest.sha256!==profile.engineSha256)throw new Error(`DRPY_ENGINE_PROFILE_UNVERIFIED: engine sha256 ${manifest.sha256}`);
  for(const [name,expected] of Object.entries(profile.dependencies)){
    const dep=manifest.dependencies.find(item=>new URL(item.url).pathname.endsWith('/'+name));
    if(!dep||dep.sha256!==expected)throw new Error(`DRPY_ENGINE_PROFILE_UNVERIFIED: dependency ${name}`);
  }
  return profile;
}
