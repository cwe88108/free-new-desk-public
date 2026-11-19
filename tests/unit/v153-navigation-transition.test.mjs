import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse} from '@vue/compiler-sfc';

const app=await readFile(new URL('../../apps/desktop/src/renderer/App.vue',import.meta.url),'utf8');
const css=await readFile(new URL('../../apps/desktop/src/renderer/styles.css',import.meta.url),'utf8');
const root=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
const desktop=JSON.parse(await readFile(new URL('../../apps/desktop/package.json',import.meta.url),'utf8'));
const lock=JSON.parse(await readFile(new URL('../../package-lock.json',import.meta.url),'utf8'));

test('route content mounts directly without a full-page visibility transition',()=>{
  const parsed=parse(app);
  assert.equal(parsed.errors.length,0);
  assert.match(parsed.descriptor.template.content,/<main class="content"><RouterView\s*\/>/);
  assert.doesNotMatch(css,/\.route-(?:enter|leave)-/);
  assert.match(app,/const version=ref\(''\)/);
  assert.match(app,/version\.value=info\.version/);
});

test('navigation and poster focus effects remain limited to normal motion preference',()=>{
  assert.match(css,/@media \(prefers-reduced-motion: no-preference\)\s*\{\s*\.nav-item:focus-visible[^}]+\}\s*\.poster-card:focus-visible \.poster-art/);
});

test('root, desktop and lockfile versions remain aligned',()=>{
  assert.match(root.version,/^\d+\.\d+\.\d+$/);
  assert.equal(desktop.version,root.version);
  assert.equal(lock.version,root.version);
  assert.equal(lock.packages[''].version,root.version);
  assert.equal(lock.packages['apps/desktop'].version,root.version);
});
