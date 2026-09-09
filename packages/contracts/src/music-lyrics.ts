export interface LrcLine{time:number;text:string;}
export function parseLrc(text:string):LrcLine[]{
  const offset=Number(/\[offset:([+-]?\d+)\]/i.exec(text)?.[1]??0)/1000,groups=new Map<number,string[]>();
  for(const line of text.replace(/^\uFEFF/,'').split(/\r?\n/)){
    const matches=[...line.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)],body=line.replace(/\[[^\]]+\]/g,'').trim();
    for(const tag of matches){if(Number(tag[2])>=60)continue;const time=Math.max(0,Number(tag[1])*60+Number(tag[2])+Number(`0.${tag[3]??0}`)+offset),rows=groups.get(time)??[];if(!rows.includes(body))rows.push(body);groups.set(time,rows);}
  }return [...groups].sort((a,b)=>a[0]-b[0]).map(([time,rows])=>({time,text:rows.join('\n')}));
}
export function activeLyricIndex(lines:LrcLine[],position:number):number{let low=0,high=lines.length;while(low<high){const mid=(low+high)>>>1;if(lines[mid]!.time<=position)low=mid+1;else high=mid;}return low-1;}
