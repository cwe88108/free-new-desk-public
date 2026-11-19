/** Log and diagnostic redaction. Never mutate application data or source credentials. */
const restrictedKey=/^(?:password|passphrase|passwd|secret|token|access[_-]?Token|refresh[_-]?Token|(?:x[_-])?api[_-]?Key|authorization|proxy[_-]?Authorization|cookie|set[_-]?Cookie|credentials|credentialRef|headers|path|filePath|root|uncPath|endpoint|url|epg)$/i;
const sensitiveKey=/cookie|authorization|token|password|passwd|passphrase|secret|api[_-]?key/i;
// Use the same sensitive-key vocabulary for objects and key/value text, including prefixed keys.
const sensitiveText=new RegExp(String.raw`\b([\w.-]*(?:${sensitiveKey.source})[\w.-]*)[\\"']*\s*[:=]\s*[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*`,'gi');

/** Keep the diagnostic structure while removing private paths, signed URLs and credentials. */
export function redactDiagnosticText(value:string):string{
  return value
    .replace(/\b(?:https?|rtsps?|smb):\/\/[^\s"'<>]+/gi,'[REDACTED_URL]')
    .replace(/\\\\[^\s"'\\]+\\[^\s"']+/g,'[REDACTED_PATH]')
    .replace(/\b[A-Za-z]:\\[^\s"']+/g,'[REDACTED_PATH]')
    .replace(sensitiveText,'$1=[REDACTED]');
}
export function redactDiagnosticArtifact(value:unknown):unknown{
  const seen=new WeakSet<object>();
  const walk=(item:unknown):unknown=>{
    if(typeof item==='string')return redactDiagnosticText(item);
    if(!item||typeof item!=='object')return item;
    if(seen.has(item))return'[REDACTED_CYCLE]';
    seen.add(item);
    if(item instanceof Error)return{name:redactDiagnosticText(item.name),message:redactDiagnosticText(item.message),...(item.stack?{stack:redactDiagnosticText(item.stack)}:{}),...(item.cause!==undefined?{cause:walk(item.cause)}:{})};
    if(Array.isArray(item))return item.map(walk);
    return Object.fromEntries(Object.entries(item as Record<string,unknown>).map(([key,entry])=>[key,(restrictedKey.test(key)||sensitiveKey.test(key))?'[REDACTED]':walk(entry)]));
  };
  return walk(value);
}
