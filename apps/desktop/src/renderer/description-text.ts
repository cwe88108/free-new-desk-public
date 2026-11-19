/** Convert source-provided HTML to display text, never to trusted HTML.
 * A template's detached content is inert: scripts, images and frames are never
 * attached to the live document. Callers must still use Vue text interpolation.
 */
export function descriptionToText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '';
  const template = document.createElement('template');
  template.innerHTML = value;
  const hidden = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH', 'NOSCRIPT']);
  const blocks = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'BLOCKQUOTE', 'PRE', 'LI', 'UL', 'OL', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const output: string[] = [];
  // Iterative traversal also handles deeply nested, untrusted source markup.
  const pending: Array<Node | string> = Array.from(template.content.childNodes).reverse();
  while (pending.length) {
    const node = pending.pop()!;
    if (typeof node === 'string') { output.push(node); continue; }
    if (node.nodeType === 3) { output.push(node.textContent ?? ''); continue; }
    if (node.nodeType !== 1) continue;
    const tag = (node as Element).tagName.toUpperCase();
    if (hidden.has(tag)) continue;
    if (tag === 'BR' || tag === 'HR') { output.push('\n'); continue; }
    const boundary = blocks.has(tag) ? '\n' : tag === 'TD' || tag === 'TH' ? ' ' : '';
    if (boundary) { output.push(boundary); pending.push(boundary); }
    for (let i = node.childNodes.length - 1; i >= 0; i--) pending.push(node.childNodes[i]!);
  }
  return output.join('').replace(/\r\n?/g, '\n').replace(/[\t\f\v \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
