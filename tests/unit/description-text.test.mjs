import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {parseFragment} from 'parse5';

const sourceUrl = new URL('../../apps/desktop/src/renderer/description-text.ts', import.meta.url);
const run = promisify(execFile);

for (const view of ['VodView', 'SearchView', 'FavoritesView']) {
  test(`${view} renders normalized descriptions only as escaped text and preserves line breaks`, async () => {
    const source = await readFile(new URL(`../../apps/desktop/src/renderer/views/${view}.vue`, import.meta.url), 'utf8');
    assert.match(source, /computed\(\(\) => descriptionToText\(detail\.value\?\.description\)\)/);
    assert.match(source, /<p class="description-text">\{\{descriptionText\|\|'该来源未提供简介。'\}\}<\/p>/);
    assert.match(source, /\.description-text\{white-space:pre-line;/);
    assert.doesNotMatch(source, /v-html="[^"\n]*(?:description|descriptionText)/);
  });
}

const cases = [
    ['<p>第一段</p><p>第二段<br>第三行</p>', '第一段\n\n第二段\n第三行'],
    ['<p>Tom &amp; Jerry&nbsp;&copy; &#20013;&#x6587; &quot;好&quot;</p>', 'Tom & Jerry © 中文 "好"'],
    ['普通简介\r\n下一行，1 < 2 > 0', '普通简介\n下一行，1 < 2 > 0'],
    ['<div>嵌套<b>内容</b><div>次段</div></div>', '嵌套内容\n次段'],
    ['<p>未闭合<b>段落', '未闭合段落'],
    ['<p title="a > b">文字</p><!--隐藏注释-->', '文字'],
    ['<script>window.pwned=1</script><style>body{display:none}</style><iframe srcdoc="<script>parent.pwned=1</script>"></iframe><svg onload="window.pwned=1"><text>隐藏</text></svg><img src="invalid:" onerror="window.pwned=1"><p>安全文字</p>', '安全文字'],
    ['&lt;img src=x onerror=window.pwned=1&gt;', '<img src=x onerror=window.pwned=1>'],
    ['<p>&nbsp;</p><br>', ''], [null, ''], [123, ''], ['', ''],
    ['<div>'.repeat(2000)+'深层'+'</div>'.repeat(2000), '深层'],
  ];

test('description traversal preserves prose and omits non-content nodes', async () => {
  // parse5 is already locked via source-adapters/cheerio. This DOM-shaped adapter
  // checks conversion deterministically; only the separate real-browser test
  // verifies browser inertness.
  function node(value) {
    return {nodeType:value.nodeName === '#text' ? 3 : value.tagName ? 1 : 8,
      textContent:value.value,tagName:value.tagName,
      childNodes:(value.childNodes ?? []).map(node)};
  }
  const document = {createElement(tag) {
    assert.equal(tag,'template');
    return {set innerHTML(html) {this.content={childNodes:parseFragment(html).childNodes.map(node)};}};
  }};
  const code = stripTypeScriptTypes(await readFile(sourceUrl,'utf8')).replace('export function','function');
  const context = {document}; vm.runInNewContext(code+';globalThis.convert=descriptionToText;',context);
  for (const [index,[input,expected]] of cases.entries()) assert.equal(context.convert(input),expected,`case ${index}`);
});

test('real browser: source HTML becomes inert, readable text', {skip:process.env.RUN_BROWSER_DESCRIPTION_TEST !== '1'}, async t => {
  // Use the actual browser parser, not a mock DOM. Set CHROME_BIN on machines
  // whose Chrome/Chromium is not in one of these standard locations.
  const candidates = [process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe')].filter(Boolean);
  let browser;
  for (const candidate of candidates) { try { await access(candidate); browser = candidate; break; } catch {} }
  if (!browser) { t.skip('Chrome/Chromium not installed; set CHROME_BIN to run DOM regression coverage'); return; }
  const directory = await mkdtemp(join(tmpdir(), 'fnd-description-'));
  t.after(() => rm(directory, {recursive:true, force:true}));
  const code = stripTypeScriptTypes(await readFile(sourceUrl, 'utf8')).replace('export function', 'function');

  const payload = `${code}\nwindow.pwned=0;const results=${JSON.stringify(cases)}.map(([input,expected])=>({actual:descriptionToText(input),expected}));setTimeout(()=>{document.getElementById('result').textContent=JSON.stringify({results,pwned:window.pwned,elements:document.querySelectorAll('img,iframe,svg,style').length});},100);`;
  const html = '<!doctype html><meta charset="utf-8"><pre id="result"></pre><script>'+payload.replace(/<\/script/gi, '<\\/script')+'</script>';
  const file = join(directory, 'case.html'); await writeFile(file, html);
  const {stdout} = await run(browser, ['--headless', '--disable-gpu', '--disable-background-networking', '--user-data-dir='+join(directory,'profile'), '--virtual-time-budget=1000', '--dump-dom', pathToFileURL(file).href], {timeout:30000,maxBuffer:2*1024*1024,env:{...process.env,XDG_CONFIG_HOME:directory}});
  const match = stdout.match(/<pre id="result">([\s\S]*?)<\/pre>/); assert.ok(match, 'browser produced results');
  const result = JSON.parse(match[1].replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'));
  for (const [index, item] of result.results.entries()) assert.equal(item.actual,item.expected,`case ${index}`);
  assert.equal(result.pwned,0); assert.equal(result.elements,0);
});
