import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, looks, scenes } from './water_boards.mjs';
const crop = { x: 1, y: 2, width: 320, height: 240 };
const valid = () => ({
  cdp: 'http://127.0.0.1:9222',
  pageUrl: 'http://127.0.0.1/game',
  out: '/tmp/water',
  videoInput: [],
  scenes: { g2: { state: 'save-hash', zoom: 2.5, crop, screenCrop: crop, shoreCrop: crop } },
});
test('all requested comparison scenes and five rows are inventoried', () => {
  assert.equal(scenes.length, 9);
  assert.deepEqual(looks, ['original', 'enhanced', 'faithful', 'muted', 'calm']);
});
test('accepts explicit missing scenes and rejects ambiguous capture geometry', () => {
  const m = valid();
  m.scenes.night = { missing: 'no native save' };
  assert.equal(validateManifest(m), m);
  assert.throws(() => validateManifest({ ...m, scenes: { bad: { missing: 'unknown' } } }), /Unknown scene/);
  assert.throws(() => validateManifest({ ...m, scenes: { g2: { ...m.scenes.g2, zoom: 3 } } }), /zoom=2.5/);
  assert.throws(
    () => validateManifest({ ...m, scenes: { g2: { ...m.scenes.g2, screenCrop: { ...crop, width: 640 } } } }),
    /1:1/,
  );
});
