import * as http from 'node:http';

// Electron utility processes do not apply this Node startup flag automatically.
// Respect explicit opt-in only; the native API also preserves NO_PROXY rules.
export function initializeEnvironmentProxy():void{
  if(process.env.NODE_USE_ENV_PROXY!=='1')return;
  const api=http as typeof http&{setGlobalProxyFromEnv?:()=>unknown};
  api.setGlobalProxyFromEnv?.();
}
initializeEnvironmentProxy();
