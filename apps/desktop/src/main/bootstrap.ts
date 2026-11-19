import { app,protocol } from 'electron';
import {join} from 'node:path';
import {profileDirectory} from './distribution.js';

// The public distribution must not read the private edition profile.
if(!app.commandLine.hasSwitch('user-data-dir'))app.setPath('userData',join(app.getPath('appData'),profileDirectory));

// Do not import features that open the profile database until this process owns the lock.
if(!app.requestSingleInstanceLock()){
  app.quit();
}else{
  protocol.registerSchemesAsPrivileged([{scheme:'fnd-image',privileges:{standard:true,secure:true,corsEnabled:false,supportFetchAPI:false}}]);
  let pendingActivation=false;
  let activate:(()=>void)|undefined;
  app.on('second-instance',()=>{if(activate)activate();else pendingActivation=true;});
  try{
    // Guards must wrap IPC before music and legacy feature handlers register.
    await import('./playback-session-ipc.js');
    await import('./music-service.js');
    await import('./fullscreen-overlay.js');
    const main=await import('./index.js');
    activate=main.showMainWindow;
    if(pendingActivation)activate();
  }catch(error){
    console.error('Application initialization failed',error);
    app.exit(1);
  }
}
