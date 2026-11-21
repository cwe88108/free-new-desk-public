type SurfaceBounds={x:number;y:number;width:number;height:number};
// Native child windows ignore CSS overflow. Hide clipped surfaces until scrolled back.
export function surfaceFitsContent(bounds:SurfaceBounds,clip:{left:number;top:number;right:number;bottom:number}):boolean{
  return bounds.x>=clip.left-1&&bounds.y>=clip.top-1&&bounds.x+bounds.width<=clip.right+1&&bounds.y+bounds.height<=clip.bottom+1;
}
type LeaseState={ownerId:string;scope:string;generation:number;lastBounds?:SurfaceBounds;lastVisible:boolean;lastSentKey?:string;released:boolean;releasePromise?:Promise<void>};
type PendingSync={state:LeaseState;bounds:SurfaceBounds;visible:boolean;waiters:Array<{resolve:(value:boolean)=>void;reject:(reason:unknown)=>void}>};
let currentOwner='';let currentGeneration=0;let tail:Promise<void>=Promise.resolve();let fullscreen=false;let activeState:LeaseState|undefined;let pendingSync:PendingSync|undefined;let syncDraining=false;
let runtimeIdentity='';let runtimeRevision=0;let hostEpoch='';
const occludingPanels = new Set<string>();

export function setNativeSurfaceOccluded(panel: string, occluded: boolean): void {
  if (window.desktop.rollback?.nativeOcclusion) return;
  const wasOccluded = occludingPanels.size > 0;
  if (occluded) occludingPanels.add(panel);
  else occludingPanels.delete(panel);
  const state = activeState;
  if (wasOccluded === (occludingPanels.size > 0) || fullscreen || !state?.lastBounds || state.released || !state.lastVisible) return;
  void coalescedSync(state, state.lastBounds, true).catch(() => false);
}
function enqueue<T>(work:()=>Promise<T>):Promise<T>{const next=tail.then(work,work);tail=next.then(()=>undefined,()=>undefined);return next;}
function settlePending(state:LeaseState,value=false):void{if(pendingSync?.state!==state)return;const pending=pendingSync;pendingSync=undefined;for(const waiter of pending.waiters)waiter.resolve(value);}
function coalescedSync(state:LeaseState,bounds:SurfaceBounds,visible:boolean):Promise<boolean>{return new Promise<boolean>((resolve,reject)=>{if(pendingSync&&pendingSync.state!==state){const stale=pendingSync;pendingSync=undefined;for(const waiter of stale.waiters)waiter.resolve(false);}if(pendingSync){pendingSync.bounds=bounds;pendingSync.visible=visible;pendingSync.waiters.push({resolve,reject});}else pendingSync={state,bounds,visible,waiters:[{resolve,reject}]};if(!syncDraining)void drainSync();});}
async function drainSync():Promise<void>{if(syncDraining)return;syncDraining=true;try{while(pendingSync){const current=pendingSync;pendingSync=undefined;try{const value=await enqueue(()=>sendSync(current.state,current.bounds,current.visible));for(const waiter of current.waiters)waiter.resolve(value);}catch(error){for(const waiter of current.waiters)waiter.reject(error);}}}finally{syncDraining=false;if(pendingSync)void drainSync();}}
async function sendSync(state:LeaseState,bounds:SurfaceBounds,visible:boolean,force=false):Promise<boolean>{
  visible = visible && occludingPanels.size === 0;
  const clip=window.document?.querySelector('.content')?.getBoundingClientRect();
  if(clip&&visible)visible=surfaceFitsContent(bounds,clip);
  const generation=state.generation,revision=runtimeRevision;
  const ownsSurface=()=>!state.released&&currentOwner===state.ownerId&&currentGeneration===generation&&state.generation===generation&&runtimeRevision===revision;
  if(!ownsSurface())return false;
  const scale=window.devicePixelRatio,key=`${bounds.x},${bounds.y},${bounds.width},${bounds.height},${scale},${visible?1:0}`;
  if(!force&&state.lastSentKey===key)return true;
  const started=performance.now();
  const result=await window.desktop.playback.control({command:'window-sync',...bounds,scale,visible});
  const accepted=result.ok&&ownsSurface();
  if(accepted)state.lastSentKey=key;
  void window.desktop.diagnostics.recordPerformance('surfaceAttachMs',performance.now()-started).catch(()=>false);
  return accepted;
}
export interface NativeSurfaceLease{ownerId:string;sync(bounds:SurfaceBounds,visible?:boolean):Promise<boolean>;hide():Promise<void>;restore():Promise<boolean>;release():Promise<void>;}
export function createNativeSurfaceLease(scope:string):NativeSurfaceLease{const ownerId=scope+':'+crypto.randomUUID();const state:LeaseState={ownerId,scope,generation:0,lastVisible:false,released:false};
  const claim=()=>{const started=performance.now();if(state.released)throw new Error('Native surface lease has already been released');if(!state.generation||currentOwner!==ownerId){delete state.lastSentKey;state.generation=++currentGeneration;currentOwner=ownerId;activeState=state;document.documentElement.dataset.nativeSurfaceOwner=scope;}void window.desktop.diagnostics.recordPerformance('surfaceClaimMs',performance.now()-started).catch(()=>false);return state.generation;};
  return{ownerId,async sync(bounds,visible=true){claim();state.lastBounds=bounds;state.lastVisible=visible;if(fullscreen&&visible)return true;return coalescedSync(state,bounds,visible);},async hide(){const bounds=state.lastBounds;if(!bounds||state.released)return;state.lastVisible=false;settlePending(state,false);await enqueue(async()=>{await sendSync(state,bounds,false).catch(()=>false);});},async restore(){const bounds=state.lastBounds;if(!bounds||state.released||!state.lastVisible||fullscreen)return false;return coalescedSync(state,bounds,true);},async release(){if(state.releasePromise)return state.releasePromise;if(state.released)return;const bounds=state.lastBounds;state.released=true;state.lastVisible=false;settlePending(state,false);const queuedAt=performance.now();void window.desktop.diagnostics.recordPerformance('surfaceReleaseQueuePending',1).catch(()=>false);state.releasePromise=enqueue(async()=>{void window.desktop.diagnostics.recordPerformance('surfaceReleaseQueuePending',0).catch(()=>false);void window.desktop.diagnostics.recordPerformance('surfaceReleaseQueueMs',performance.now()-queuedAt).catch(()=>false);if(bounds&&currentOwner===ownerId&&currentGeneration===state.generation){const ipcStarted=performance.now();void window.desktop.diagnostics.recordPerformance('surfaceReleaseIpcPending',1).catch(()=>false);try{const result=await window.desktop.playback.control({command:'window-sync',...bounds,scale:window.devicePixelRatio,visible:false});if(!result.ok)throw new Error(result.detail??'PlayerHost did not acknowledge native surface hide');}finally{void window.desktop.diagnostics.recordPerformance('surfaceReleaseIpcMs',performance.now()-ipcStarted).catch(()=>false);void window.desktop.diagnostics.recordPerformance('surfaceReleaseIpcPending',0).catch(()=>false);}}if(currentOwner===ownerId&&currentGeneration===state.generation){currentOwner='';currentGeneration+=1;if(activeState===state)activeState=undefined;delete document.documentElement.dataset.nativeSurfaceOwner;}});try{await state.releasePromise;state.generation=0;}catch(error){state.released=false;delete state.lastSentKey;delete state.releasePromise;throw error;}}};}
window.desktop.playback.onFullscreenChanged(value=>{fullscreen=value;if(value){if(activeState){settlePending(activeState,true);delete activeState.lastSentKey;}document.documentElement.dataset.nativeSurfaceFullscreen='true';return;}delete document.documentElement.dataset.nativeSurfaceFullscreen;const state=activeState;if(!state?.lastBounds||state.released||!state.lastVisible)return;settlePending(state,false);void enqueue(()=>sendSync(state,state.lastBounds!,true,true)).catch(()=>undefined);});
window.desktop.playback.onRuntimeSessionChanged(session=>{
  const identity=JSON.stringify([session.generation,session.requestId,session.loadId,session.hostEpoch]);
  if(identity===runtimeIdentity)return;
  runtimeIdentity=identity;runtimeRevision+=1;
  const hostChanged=Boolean(session.hostEpoch&&session.hostEpoch!==hostEpoch);
  hostEpoch=session.hostEpoch??'';
  const state=activeState;if(!state)return;
  delete state.lastSentKey;settlePending(state,false);
  if(hostChanged&&(session.domain==='vod'||session.domain==='live')&&state.lastBounds&&!state.released&&state.lastVisible&&!fullscreen){
    void coalescedSync(state,state.lastBounds,true).catch(()=>undefined);
  }
});
