import type {DrpyEngineManifest} from './drpy-engine-manager.js';

export const DRPY2_HOST_ABI_VERSION='fnd-drpy2-host/3';
export type DrpyInstantiation='object'|'factory'|'constructor';
export interface Drpy2Profile{
  id:string;
  hostAbiVersion:string;
  runtimeFamily:'drpy2-esm';
  engineSha256:string;
  dependencies:Record<string,string>;
  instantiation:DrpyInstantiation;
  initContractId:'rule-ext-string-v1';
  methodContractIds:Record<string,string>;
  requiredCapabilities:string[];
  allowedModuleSpecifiers:string[];
  validationSuiteId:string;
  certification:'public-pinned'|'controlled-fixture';
  methods:{home:string;homeVod:string;category:string;detail:string;search:string;play:string};
}

const commonMethods={home:'home',homeVod:'homeVod',category:'category',detail:'detail',search:'search',play:'play'} as const;
const commonContracts={home:'home-v1',homeVod:'home-v1',category:'category-v1',detail:'detail-v1',search:'search-v1',play:'play-v1'};
const qistDrpy2_3952:Drpy2Profile={
  id:'qist-drpy2-3.9.52beta3-20250801',
  hostAbiVersion:DRPY2_HOST_ABI_VERSION,
  runtimeFamily:'drpy2-esm',
  engineSha256:'67f4f6b460db1ec7ef50585953ce826c5263ca91d72958490ef4702b4e154fe1',
  dependencies:{'drpy-core-lite.min.js':'18bab373dfa67a4956f25f273fafb3e5b6b9fdf7bafb21acf0f6264b474900f5'},
  instantiation:'object',
  initContractId:'rule-ext-string-v1',
  methodContractIds:commonContracts,
  requiredCapabilities:['req-sync','local-namespaced','pdfh','pdfa','pd','crypto-basic'],
  allowedModuleSpecifiers:['./','../'],
  validationSuiteId:'qist-3.9.52beta3-contract-v2',
  certification:'public-pinned',
  methods:{...commonMethods},
};

const controlledV1:Drpy2Profile={
  id:'fnd-controlled-drpy2-v1',
  hostAbiVersion:DRPY2_HOST_ABI_VERSION,
  runtimeFamily:'drpy2-esm',
  engineSha256:'a46efae61c9f4624268d651123beb25a544594357d5e844011973c0426b705d9',
  dependencies:{'core.js':'768fdba34ae04478b804aa3f56f996fe906f40c84af2baf5e80d0a93deebe48d'},
  instantiation:'factory',
  initContractId:'rule-ext-string-v1',
  methodContractIds:commonContracts,
  requiredCapabilities:['req-sync','local-namespaced','pdfh','pdfa','pd'],
  allowedModuleSpecifiers:['./','../'],
  validationSuiteId:'fnd-controlled-drpy2-v1-contract',
  certification:'controlled-fixture',
  methods:{...commonMethods},
};

export const DRPY2_PROFILES:readonly Drpy2Profile[]=[qistDrpy2_3952,controlledV1];

function dependencyMatches(manifest:DrpyEngineManifest,profile:Drpy2Profile):boolean{
  const expected=Object.entries(profile.dependencies);
  if(manifest.dependencies.length!==expected.length)return false;
  return expected.every(([name,digest])=>{
    const dep=manifest.dependencies.find(item=>{
      try{return new URL(item.url).pathname.endsWith('/'+name);}catch{return false;}
    });
    return dep?.sha256===digest;
  });
}

export function resolveDrpy2Profile(manifest:DrpyEngineManifest):Drpy2Profile{
  const profile=DRPY2_PROFILES.find(item=>item.engineSha256===manifest.sha256&&dependencyMatches(manifest,item));
  if(!profile)throw new Error(`DRPY_ENGINE_PROFILE_UNVERIFIED: engine sha256 ${manifest.sha256}`);
  return profile;
}

export function profileSummary(profile:Drpy2Profile){
  return{id:profile.id,hostAbiVersion:profile.hostAbiVersion,engineSha256:profile.engineSha256,dependencyCount:Object.keys(profile.dependencies).length,validationSuiteId:profile.validationSuiteId,certification:profile.certification};
}
