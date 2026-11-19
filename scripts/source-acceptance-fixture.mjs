// Local acceptance data only. Never copies credentials into the test profile.
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {DataService} from '../services/data-service/dist/index.js';
const root=path.resolve('../审核报告/来源模块验收-2026-10-21');
await mkdir(root,{recursive:true});
const original=new DatabaseSync(path.join(process.env.APPDATA,'free-new-desk/data/app.db'),{readOnly:true});
await backup(original,path.join(root,'original-app.backup.db'));original.close();
const profile=path.join(root,'test-profile');await mkdir(path.join(profile,'data'),{recursive:true});
const store=new DataService(path.join(profile,'data/app.db'));
store.setSetting('update.autoCheck','false');store.setSetting('network.proxyMode','direct');
for(let i=1;i<=30;i++)store.saveSource({id:`acceptance-vod-${i}`,name:`验收点播 ${i}`,kind:'T1_JSON',endpoint:'https://example.invalid/api',enabled:i%2===0,trust:'A',importGroupId:'acceptance-group',sourceLabel:'验收批次',importedAt:'2026-10-21T00:00:00Z'});
store.saveLiveSource({id:'acceptance-live',name:'验收直播',endpoint:'https://example.invalid/test.m3u',enabled:true,origin:'remote-playlist',importGroupId:'acceptance-group',sourceLabel:'验收批次',importedAt:'2026-10-21T00:00:00Z'});
store.importFavorites({vod:[{sourceId:'acceptance-vod-1',sourceName:'验收点播 1',videoId:'test',name:'验收收藏',createdAt:'2026-10-21T00:00:00Z'}]});
store.close();console.log(JSON.stringify({backup:path.join(root,'original-app.backup.db'),profile}));
