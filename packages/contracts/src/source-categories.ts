import type {SourceCategory} from './index.js';

export function categoryGroup(name:string):string{
  const value=name.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu,'').toLowerCase();
  if(['电影','电影片','影片'].includes(value))return '电影';
  if(['剧集','连续剧','电视剧','电视连续剧'].includes(value))return '剧集';
  if(['综艺','综艺片','综艺节目'].includes(value))return '综艺';
  if(['动漫','动漫片','动画','动画片'].includes(value))return '动漫';
  return value;
}

export function categoryShortcutCandidates(categories:SourceCategory[],name:string):string[]{
  const group=categoryGroup(name);
  const root=categories.find(item=>categoryGroup(item.name)===group);
  if(root)return [root.id];
  // Some CMS sites declare paths (电影/动作片) rather than separate parent rows.
  return categories.filter(item=>{const parts=item.name.split(/[/／]/);return parts.length>1&&categoryGroup(parts[0]??'')===group;}).map(item=>item.id);
}
export function categoryShortcutTarget(categories:SourceCategory[],name:string):string|undefined{return categoryShortcutCandidates(categories,name)[0];}

const flatCmsGroupLabels=new Map<string,readonly string[]>([
  ['电影',['动作片','喜剧片','爱情片','科幻片','恐怖片','剧情片','战争片','悬疑片','犯罪片']],
  ['剧集',['国产剧','大陆剧','香港剧','台湾剧','韩国剧','日本剧','欧美剧','泰国剧','海外剧']],
  ['综艺',['大陆综艺','国产综艺','港台综艺','日韩综艺','欧美综艺','海外综艺']],
  ['动漫',['国产动漫','大陆动漫','日本动漫','日韩动漫','欧美动漫','港台动漫','海外动漫']],
]);

// Prefer declared edges, then query the source's own IDs for recognizable flat category labels.
export function cmsCategoryCandidates(categories:SourceCategory[],requested:string):string[]{
  const selected=requested?categories.find(item=>item.id===requested):undefined;
  if(!selected)return [requested];
  const descendants=new Set([requested]);
  let changed=true;
  while(changed){changed=false;for(const item of categories){if(item.parentId&&descendants.has(item.parentId)&&!descendants.has(item.id)){descendants.add(item.id);changed=true;}}}
  const parents=new Set(categories.map(item=>item.parentId).filter(Boolean));
  const leaves=categories.filter(item=>item.id!==requested&&descendants.has(item.id)&&!parents.has(item.id)).map(item=>item.id);
  if(leaves.length)return leaves;
  const group=categoryGroup(selected.name);
  const labels=flatCmsGroupLabels.get(group);
  if(!labels||selected.parentId||descendants.size>1)return [requested];
  const flat=categories.filter(item=>{
    if(item.id===requested||item.parentId)return false;
    const path=item.name.split(/[/／]/);
    return path.length>1?categoryGroup(path[0]??'')===group:labels.includes(categoryGroup(item.name));
  });
  return [requested,...flat.map(item=>item.id)];
}
export function cmsCategoryTarget(categories:SourceCategory[],requested:string):string{return cmsCategoryCandidates(categories,requested)[0]??requested;}

export function visibleSourceCategories(categories:SourceCategory[],names:string[]):SourceCategory[]{
  if(!names.length)return categories;
  const allowed=new Set(names.map(categoryGroup));
  const ids=new Set(categories.filter(item=>allowed.has(categoryGroup(item.name))||allowed.has(categoryGroup(item.name.split(/[/／]/)[0]??''))).map(item=>item.id));
  // These are display preferences, not an execution authorization boundary.
  if(!ids.size)return categories;
  let changed=true;
  while(changed){changed=false;for(const item of categories){if(item.parentId&&ids.has(item.parentId)&&!ids.has(item.id)){ids.add(item.id);changed=true;}}}
  // A configured leaf still needs its declared ancestors for the group shortcuts.
  // Add ancestors after descendants so retaining a parent does not admit excluded siblings.
  const declared=new Map(categories.map(item=>[item.id,item]));
  changed=true;
  while(changed){changed=false;for(const id of [...ids]){const parent=declared.get(id)?.parentId;if(parent&&declared.has(parent)&&!ids.has(parent)){ids.add(parent);changed=true;}}}
  return categories.filter(item=>ids.has(item.id));
}
