export const SOURCE_PAGE_SIZE=50;
export function sourcePageCount(total:number):number{return Math.max(1,Math.ceil(total/SOURCE_PAGE_SIZE));}
export function clampSourcePage(page:number,total:number):number{return Math.min(sourcePageCount(total),Math.max(1,Number.isFinite(page)?Math.floor(page):1));}
export function sourcePageItems<T>(items:readonly T[],page:number):T[]{const start=(clampSourcePage(page,items.length)-1)*SOURCE_PAGE_SIZE;return items.slice(start,start+SOURCE_PAGE_SIZE);}
