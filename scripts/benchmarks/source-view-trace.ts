// Diagnostic copy only: numbers and phase names, never source payloads.
import {onBeforeMount as traceBeforeMount,onMounted as traceMounted,onBeforeUpdate as traceBeforeUpdate,onUpdated as traceUpdated} from 'vue';
let tracePatchStarted=0,traceCapabilityCalls=0,traceCapabilityMs=0;
function traceStart(){tracePatchStarted=performance.now();traceCapabilityCalls=0;traceCapabilityMs=0;}
function traceFinish(phase:string){console.info('source-view-trace',JSON.stringify({phase,at:performance.now(),patchMs:performance.now()-tracePatchStarted,capabilityCalls:traceCapabilityCalls,capabilityMs:traceCapabilityMs,sources:sources.value.length,rows:document.querySelectorAll('.sources-page .drag-handle').length}));}
traceBeforeMount(traceStart);traceMounted(()=>traceFinish('mounted'));
traceBeforeUpdate(traceStart);traceUpdated(()=>traceFinish('updated'));
