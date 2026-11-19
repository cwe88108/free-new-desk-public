export type AccentId='zhe'|'lan'|'yu'|'jiang'|'jin';
export const ACCENT_CHOICES:Array<{id:AccentId;label:string;preview:string}>=[
  {id:'zhe',label:'赭石',preview:'#9a6a35'},
  {id:'lan',label:'黛蓝',preview:'#5b6b9e'},
  {id:'yu',label:'青玉',preview:'#3f7d5c'},
  {id:'jiang',label:'绛红',preview:'#a85555'},
  {id:'jin',label:'金褐',preview:'#a3762a'}
];
const ACCENT_TABLE:Record<AccentId,{light:[string,string];dark:[string,string]}>={
  zhe:{light:['#9a6a35','#805326'],dark:['#c59865','#deb17d']},
  lan:{light:['#5b6b9e','#42507c'],dark:['#93a7d6','#aebde4']},
  yu:{light:['#3f7d5c','#2f5f46'],dark:['#79b788','#9ccaa8']},
  jiang:{light:['#a85555','#7f3d3d'],dark:['#dd8d8d','#e9a9a9']},
  jin:{light:['#a3762a','#7c5820'],dark:['#d3a45f','#e3bb7d']}
};
export function accentIdFromStorage():AccentId{const value=localStorage.getItem('ui.accent')??'zhe';return value in ACCENT_TABLE?value as AccentId:'zhe';}
export function applyAccentToDocument(id?:AccentId):void{const accentId=id??accentIdFromStorage();const entry=ACCENT_TABLE[accentId];if(!entry)return;const theme=document.documentElement.dataset.theme==='dark'?'dark':'light';const [accent,strong]=entry[theme];document.documentElement.style.setProperty('--accent',accent);document.documentElement.style.setProperty('--accent-strong',strong);}
export async function persistAccent(id:AccentId):Promise<void>{localStorage.setItem('ui.accent',id);try{await window.desktop.settings.set('ui.accent',id);}catch{/* 设置落库失败时本地仍生效 */}}
