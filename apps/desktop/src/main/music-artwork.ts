import path from 'node:path';

const imageExtensions=['.jpg','.jpeg','.png','.webp'];
const defaultNames=['cover','folder','front'];

function safeStem(value:string|undefined):string|undefined{
  const clean=(value??'').normalize('NFKC').trim();
  if(!clean||/[<>:"/\\|?*\x00-\x1F]/.test(clean)||clean==='.'||clean==='..')return;
  return clean;
}

export function localArtworkCandidates(audioFile:string,metadata:{album?:string;title?:string}={}):string[]{
  const directory=path.dirname(audioFile),stem=audioFile.slice(0,-path.extname(audioFile).length),values:string[]=[];
  for(const ext of imageExtensions)values.push(`${stem}${ext}`);
  const album=safeStem(metadata.album);if(album)for(const ext of imageExtensions)values.push(path.join(directory,`${album}${ext}`));
  const title=safeStem(metadata.title);if(title&&title!==album)for(const ext of imageExtensions)values.push(path.join(directory,`${title}${ext}`));
  for(const name of defaultNames)for(const ext of imageExtensions)values.push(path.join(directory,`${name}${ext}`));
  return [...new Set(values)];
}
