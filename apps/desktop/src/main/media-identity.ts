import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Path normalization is not an authorization check or a substitute for load identity. */
export function mediaIdentity(input:string):string|undefined {
  // Only our CUE transport suffix is removed, never arbitrary URL query parameters.
  const value=input.replace(/#fnd-segment=\d+(?:\.\d+)?,(?:\d+(?:\.\d+)?)?$/,'');
  const local=(v:string)=>`file:${path.win32.normalize(v).replace(/\\/g,'/').toLowerCase()}`;
  if (/^\\\\[?.]\\/.test(value)) return undefined; // extended/device paths need explicit support
  if (/^[a-z]:[\\/]/i.test(value)||/^\\\\[^\\]+\\[^\\]+/.test(value)) return local(value);
  try {
    const url=new URL(value);
    if(url.protocol==='file:')return local(fileURLToPath(url,{windows:true}));
    if(url.protocol==='http:'||url.protocol==='https:')return `url:${url.href}`;
  } catch { /* unknown identity is rejected, never decoded a second time */ }
  return undefined;
}
export function sameMediaPath(actual:string|undefined,expected:string):boolean {
  const a=actual?mediaIdentity(actual):undefined,b=mediaIdentity(expected);
  return a!==undefined&&b!==undefined&&a===b;
}
