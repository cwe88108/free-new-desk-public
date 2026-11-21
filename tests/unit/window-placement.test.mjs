import assert from 'node:assert/strict';
import test from 'node:test';
import { fitWindowToWorkArea, minimumWindowSize } from '../../apps/desktop/dist/main/window-placement.js';

test('restores a legacy window inside a high-DPI work area and keeps secondary display coordinates', () => {
  const area = { x:-1093, y:30, width:1093, height:584 };
  const restored = fitWindowToWorkArea(area, { x:-2500, y:-200, width:1440, height:900 });
  assert.deepEqual(restored, area);
  assert.deepEqual(minimumWindowSize(area), [800,540]);
});

test('constrains the minimum and invalid saved geometry to the actual work area', () => {
  const area = { x:10, y:40, width:720, height:500 };
  assert.deepEqual(minimumWindowSize(area), [720,500]);
  assert.deepEqual(fitWindowToWorkArea(area, { x:Infinity, y:NaN, width:NaN, height:-1 }), area);
});
