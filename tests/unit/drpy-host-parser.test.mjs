import test from 'node:test';
import assert from 'node:assert/strict';
import {createDrpy2RuntimeShim,joinUrl,pdfh,pdfa,pd} from '../../packages/catvod-runtime-shim/dist/index.js';

const html=`<main><section class="cards"><article class="item"><a href="/one"><img data-src="/one.jpg"><span class="title">One <em>HD</em></span></a><i class="remove">junk</i></article><article class="item"><a data-href="/two"><img style="background-image:url('/two.jpg')"><span class="title">Two</span></a><i class="remove">noise</i></article></section></main>`;

test('drpy host parser returns arrays and chained Text/attributes',()=>{
  const rows=pdfa(html,'.cards&&article.item');assert.equal(rows.length,2);
  assert.equal(pdfh(rows[0],'a&&Text'),'One HD');assert.equal(pdfh(rows[0],'a&&href||data-href'),'/one');
  assert.equal(pdfh(rows[1],'a&&href||data-href'),'/two');
});

test('drpy host parser supports eq exclusions style urls and URL joining',()=>{
  assert.equal(pdfh(html,'.item:eq(1)&&.title&&Text'),'Two');
  assert.equal(pdfh(html,'.item--.remove&&Text'),'One HD');
  const second=pdfa(html,'.cards&&article.item')[1];assert.equal(pdfh(second,'img&&style'),'/two.jpg');
  assert.equal(pd(second,'a&&data-href','https://example.test/base/'),'https://example.test/two');
  assert.equal(joinUrl('https://example.test/a/b','../c'),'https://example.test/c');
  assert.equal(joinUrl('https://example.test/a','//cdn.example.test/x'),'https://cdn.example.test/x');
  assert.equal(joinUrl('https://example.test/a','magnet:?xt=demo'),'magnet:?xt=demo');
});

test('drpy2 local storage supports engine namespace key value ABI without collisions',()=>{
  const store=new Map(),shim=createDrpy2RuntimeShim({sourceId:'fixture',store,reqSync:()=>({content:'',code:200})});
  assert.equal(shim.local.set('rule-a','cookie','A'),true);assert.equal(shim.local.set('rule-b','cookie','B'),true);
  assert.equal(shim.local.get('rule-a','cookie'),'A');assert.equal(shim.local.get('rule-b','cookie'),'B');
  assert.equal(shim.local.delete('rule-a','cookie'),true);assert.equal(shim.local.get('rule-a','cookie'),'');
});
