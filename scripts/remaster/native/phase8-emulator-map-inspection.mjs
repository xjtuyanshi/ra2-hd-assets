import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { phase8MenuRoutes, usableMenuControl } from './phase8-menu-measure.mjs';

// All selection and scrolling use ordinary browser input. Metadata reads never call guest procedures.
export async function inspectEmulatorMapModes({ page, out, state, click, point, shot, wait, record, ownerIdle }) {
  const find = (snapshot, id) => snapshot.controls.find((value) => usableMenuControl(value) && value.id === id);
  const inspect = async () => {
    const snapshot = await state();
    const types = find(snapshot, 1771);
    const maps = find(snapshot, 1363);
    assert(types && maps, 'Genuine map dialog lists required');
    const scrollbar = snapshot.controls.find(
      (value) =>
        usableMenuControl(value) &&
        value.class?.toLowerCase() === 'scrollbar' &&
        value.parentHwnd === maps.parentHwnd &&
        value.rect[0] >= maps.rect[2] - 2 &&
        value.rect[1] === maps.rect[1],
    );
    return { types, maps, scrollbar };
  };
  for (const route of phase8MenuRoutes.slice(0, 3)) {
    await ownerIdle();
    const source = find(await state(), route.id);
    assert(source, 'Missing map-inspection navigation control ' + route.id);
    await click((source.rect[0] + source.rect[2]) / 2, (source.rect[1] + source.rect[3]) / 2);
    await wait('map-inspection navigation ' + route.expected, async () => find(await state(), route.expected), 30000);
    await delay(2000);
  }
  const original = await inspect();
  assert.equal(original.types.items.length, 3, 'Three genuine game-type entries required');
  const summary = {
    kind: 'Actual emulator map-dialog inspection; no menu benchmark or native acceptance',
    gameTypeCount: original.types.items.length,
    initialGameTypeSelection: original.types.selection,
    gameTypeItemsRaw: original.types.items,
    input: 'Trusted ordinary browser coordinate clicks, focused scrollbar Home/End keys',
    textLimitation:
      'The existing shim metadata retains owner-draw item bytes decoded as control text, which may be garbled. Raw text/data and complete raw item lists are preserved; screenshots carry the actual rendered names. No guessed object layout or fabricated translation is used.',
    modes: [],
  };
  const persist = async () =>
    writeFile(
      join(out, 'maps-summary.json'),
      JSON.stringify({ ...summary, updatedAt: new Date().toISOString() }, null, 2),
    );
  for (let index = 0; index < original.types.items.length; index++) {
    await ownerIdle();
    const before = await inspect();
    const rowHeight = before.types.rowHeight;
    assert(rowHeight > 0, 'Actual game-type row height required');
    assert.equal(before.types.topIndex, 0, 'All three game-type rows must be visible before selection');
    await click((before.types.rect[0] + before.types.rect[2]) / 2, before.types.rect[1] + rowHeight * (index + 0.5));
    await wait('actual game-type selection ' + index, async () => (await inspect()).types.selection === index, 10000);
    await delay(2000);
    let top = await inspect();
    const moveScrollbar = async (key) => {
      await ownerIdle();
      const current = await inspect();
      assert(current.scrollbar?.scroll, 'Actual map scrollbar state required for ' + key);
      const rect = current.scrollbar.rect;
      const arrow = Math.min(rect[2] - rect[0], Math.floor((rect[3] - rect[1]) / 2));
      // A real arrow click focuses the real control; Home/End then uses its normal Win32 key handler.
      await click((rect[0] + rect[2]) / 2, rect[3] - arrow / 2);
      await page.keyboard.press(key);
      await record('map-scroll-input', { gameTypeIndex: index, key, before: current.scrollbar.scroll });
      return wait(
        'actual scrollbar ' + key,
        async () => {
          const after = await inspect();
          const scroll = after.scrollbar?.scroll;
          const desired =
            key === 'Home' ? scroll?.min : Math.max(scroll?.min, scroll?.max - Math.max(0, scroll?.page - 1));
          return scroll && scroll.pos === desired && (key !== 'Home' || after.maps.topIndex === 0) ? after : null;
        },
        10000,
      );
    };
    if (top.maps.topIndex !== 0) top = await moveScrollbar('Home');
    const [nx, ny] = await point(400, 560);
    await page.mouse.move(nx, ny);
    await delay(600);
    await shot(`mode-${index}-top`);
    top = await inspect();
    const result = {
      index,
      selectedGameType: top.types.selection,
      gameTypeRaw: top.types.items[index],
      mapCount: top.maps.items.length,
      fullMapItemsRaw: top.maps.items,
      firstMapRaw: top.maps.items[0] ?? null,
      lastMapRaw: top.maps.items.at(-1) ?? null,
      top: { selection: top.maps.selection, topIndex: top.maps.topIndex, scrollbar: top.scrollbar?.scroll ?? null },
      topScreenshot: `mode-${index}-top.png`,
      bottom: null,
    };
    summary.modes.push(result);
    await persist();
    if (top.scrollbar?.scroll && top.scrollbar.scroll.disabled !== 3) {
      await moveScrollbar('End');
      await page.mouse.move(nx, ny);
      await delay(600);
      await shot(`mode-${index}-bottom`);
      const bottom = await inspect();
      assert.equal(bottom.types.selection, index);
      assert.equal(bottom.maps.items.length, result.mapCount, 'Scrolling must preserve actual map count');
      result.bottom = {
        selection: bottom.maps.selection,
        topIndex: bottom.maps.topIndex,
        scrollbar: bottom.scrollbar?.scroll ?? null,
        screenshot: `mode-${index}-bottom.png`,
      };
    } else {
      result.bottom = { unnecessary: true, reason: 'Actual scrollbar disabled or absent', topIndex: top.maps.topIndex };
    }
    await record('map-mode-inspected', result);
    await persist();
  }
  await record('maps-complete', {
    gameTypeCount: summary.gameTypeCount,
    modes: summary.modes.map((mode) => ({
      index: mode.index,
      count: mode.mapCount,
      top: mode.top,
      bottom: mode.bottom,
    })),
  });
}
