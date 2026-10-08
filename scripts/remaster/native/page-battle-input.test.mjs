import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { observePageCombat } from './page-battle-input.mjs';

function scene() {
  return {
    frame: 100,
    view: { x: 10, y: 5 },
    sidebar: {
      frame: { width: 200, height: 120 },
      layout: { sidebar: { x: 100, width: 100 }, commandBar: { y: 100 } },
    },
    shroud: { originX: 0, originY: 0, width: 16, height: 16, cells: new Uint8Array(256).fill(2) },
    effects: {
      bullets: [{ id: 1, uid: 11, x: 512, y: 256, z: 0, inviso: false }],
      lasers: [],
      electricBolts: [],
    },
  };
}

test('combat evidence requires a rendered weapon in an actually visible native cell', () => {
  const state = scene();
  const observed = observePageCombat(state, 0.5);
  assert.equal(observed.visible, 1);
  assert.equal(observed.inView, 1);
  assert.deepEqual(observed.effects[0].pixel, { x: 20, y: 40 });
  state.effects.bullets[0].inviso = true;
  assert.equal(observePageCombat(state, 0.5).visible, 0);
  state.effects.bullets[0].inviso = false;
  state.shroud.cells[1 * 16 + 2] = 1;
  assert.equal(observePageCombat(state, 0.5).visible, 0);
  state.shroud.cells[1 * 16 + 2] = 0;
  assert.equal(observePageCombat(state, 0.5).visible, 0);
});

test('sidebar and command-bar pixels do not count as tactical fighting', () => {
  const state = scene();
  state.view.x = -80;
  assert.equal(observePageCombat(state, 0.5).inView, 0);
  state.view.x = 10;
  state.view.y = -55;
  assert.equal(observePageCombat(state, 0.5).inView, 0);
  state.view.y = 5;
  state.sidebar.layout.sidebar.x = 0;
  assert.equal(observePageCombat(state, 0.5).inView, 0);
});

test('visible weapon-beam endpoints qualify independently of invisible instant-hit projectiles', () => {
  const state = scene();
  state.effects.bullets[0].inviso = true;
  state.effects.lasers.push({ source: { x: 512, y: 256, z: 0 }, target: { x: 4096, y: 256, z: 0 } });
  const observed = observePageCombat(state, 0.5);
  assert.equal(observed.visible, 1);
  assert.equal(observed.inView, 1);
  assert.equal(observed.effects[0].kind, 'laser-source');
  assert.equal(observePageCombat({ ...state, shroud: null }, 0.5).inView, 0);
});

test('raised combat is checked against the flat cells the native renderer covers', () => {
  const state = scene();
  state.shroud.cells.fill(0);
  state.effects.bullets[0].z = 208;
  state.shroud.cells[0 * 16 + 1] = 2;
  const even = observePageCombat(state, 0.1);
  assert.equal(even.inView, 1);
  assert.deepEqual(even.effects[0].flatCells, [{ x: 1, y: 0 }]);
  assert.deepEqual(even.effects[0].cellEvidence, { level: 2, cells: [{ x: 1, y: 0, state: 2 }] });
  state.shroud.cells[0 * 16 + 1] = 0;
  state.shroud.cells[1 * 16 + 2] = 2;
  assert.equal(observePageCombat(state, 0.1).visible, 0);
  state.effects.bullets[0].z = 104;
  const odd = observePageCombat(state, 0.1);
  assert.equal(odd.inView, 1);
  assert.deepEqual(odd.effects[0].flatCells, [
    { x: 1, y: 0 },
    { x: 2, y: 1 },
  ]);
  assert.deepEqual(odd.effects[0].cellEvidence, {
    level: 1,
    cells: [
      { x: 1, y: 0, state: 0 },
      { x: 2, y: 1, state: 2 },
    ],
  });
  state.shroud.cells[1 * 16 + 2] = 1;
  assert.equal(observePageCombat(state, 0.1).visible, 0);
});
