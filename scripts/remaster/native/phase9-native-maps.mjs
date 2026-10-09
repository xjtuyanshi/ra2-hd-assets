import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Inspect the already-open native dialog using ordinary browser input only.
export async function inspectPhase9NativeMaps({ page, point, state, click, shot, wait, out, record, ownerIdle }) {
  const summary = {
    kind: 'Actual hidden native choose-map dialog, read-only metadata and trusted browser input',
    expectedCounts: [104, 104, 25],
    modes: [],
    completed: false,
    limitation:
      'Native topIndex can disagree with private owner-drawn scrolling. Raster changes and screenshots preserve visible evidence; they must be inspected. No guest setter or generated item list is used.',
  };
  const persist = async () => writeFile(join(out, 'native-maps-summary.json'), JSON.stringify(summary, null, 2));
  const find = (value, id) =>
    value.controls?.find((c) => c.id === id && c.visible && c.enabled && c.rect?.[2] > c.rect?.[0]);
  const inspect = async () => {
    const value = await state(),
      types = find(value, 1771),
      maps = find(value, 1363);
    assert(types?.list && maps?.list, 'Actual enabled game-type and map ListBoxes required');
    const sibling = value.controls.find(
      (c) =>
        c.visible &&
        c.enabled &&
        /^scrollbar$/i.test(c.class) &&
        c.parentHwnd === maps.parentHwnd &&
        c.rect?.[0] >= maps.rect[2] - 2 &&
        Math.abs(c.rect[1] - maps.rect[1]) < 3,
    );
    const scrollbar = sibling
      ? { rect: sibling.rect, source: 'Actual enumerated scrollbar HWND', hwnd: sibling.hwnd }
      : maps.style & 0x00200000
        ? {
            rect: [maps.rect[2] - 17, maps.rect[1], maps.rect[2], maps.rect[3]],
            source: 'Actual ListBox WS_VSCROLL nonclient right strip; standard 17 native-pixel geometry',
          }
        : null;
    return { types, maps, scrollbar, modal: value.modal, controlsTruncated: value.controlsTruncated };
  };
  const raster = async (rect) =>
    page.evaluate((rect) => {
      const frame = window.__phase7Presentation?.latestRaster;
      if (!frame?.pixels?.length) return null;
      const samples = [],
        columns = Math.ceil(frame.width / frame.spacing);
      for (let y = Math.ceil((rect[1] + 3) / frame.spacing) * frame.spacing; y < rect[3] - 3; y += frame.spacing)
        for (let x = Math.ceil((rect[0] + 3) / frame.spacing) * frame.spacing; x < rect[2] - 24; x += frame.spacing) {
          if (x >= 0 && y >= 0 && x < frame.width && y < frame.height)
            samples.push([x, y, frame.pixels[(y / frame.spacing) * columns + x / frame.spacing]]);
        }
      return { at: frame.at, width: frame.width, height: frame.height, spacing: frame.spacing, samples };
    }, rect);
  const difference = (before, after) => {
    if (!before || !after) return { available: false, changedSamples: null };
    const available =
      before.width === after.width && before.height === after.height && before.samples.length === after.samples.length;
    return {
      available,
      comparedSamples: before.samples.length,
      changedSamples: available
        ? before.samples.filter((sample, index) => sample[2] !== after.samples[index][2]).length
        : null,
    };
  };
  const settle = async () => {
    await ownerIdle();
    await delay(550);
  };
  const capture = async (label, observation) => {
    await ownerIdle();
    await shot(label);
    return {
      label,
      screenshot: `${label}.png`,
      nativeScreenshot: `${label}-native.png`,
      observation,
      raster: await raster(observation.maps.rect),
    };
  };
  const selectMode = async (index) => {
    await ownerIdle();
    const before = await inspect(),
      height = before.types.list.itemHeight;
    assert(Number.isFinite(height) && height > 0, 'Actual game-type item height required');
    await click((before.types.rect[0] + before.types.rect[2]) / 2, before.types.rect[1] + 2 + height * (index + 0.5));
    await wait(
      `actual native map game-type selection ${index}`,
      async () => {
        const next = await inspect();
        return next.types.list.selection === index ? next : null;
      },
      10000,
    );
    await settle();
    return inspect();
  };
  const moveOffList = async (maps) => {
    const [x, y] = await point(maps.rect[0] - 20, maps.rect[1] - 20);
    await page.mouse.move(x, y);
  };
  const wheel = async (maps, delta, repetitions = 3) => {
    const [x, y] = await point((maps.rect[0] + maps.rect[2]) / 2, (maps.rect[1] + maps.rect[3]) / 2);
    await page.mouse.move(x, y);
    for (let i = 0; i < repetitions; i++) {
      await ownerIdle();
      await page.mouse.wheel(0, delta);
      await delay(100);
    }
    await moveOffList(maps);
    await settle();
  };
  const dragScrollbar = async (observation, fromEnd, toEnd) => {
    const scrollbar = observation.scrollbar;
    if (!scrollbar) return { executed: false, reason: 'No enumerated scrollbar or actual WS_VSCROLL list style' };
    await ownerIdle();
    const [left, top, right, bottom] = scrollbar.rect;
    const arrow = Math.min(right - left, (bottom - top) / 2);
    const trackTop = top + arrow,
      trackBottom = bottom - arrow;
    const rows = Math.max(
      1,
      Math.floor((observation.maps.rect[3] - observation.maps.rect[1] - 4) / observation.maps.list.itemHeight),
    );
    const thumb = Math.min(
      trackBottom - trackTop,
      Math.max(arrow, ((trackBottom - trackTop) * rows) / observation.maps.list.count),
    );
    const yAt = (end) => (end === 'bottom' ? trackBottom - thumb / 2 : trackTop + thumb / 2);
    const from = await point((left + right) / 2, yAt(fromEnd));
    const to = await point((left + right) / 2, yAt(toEnd));
    await page.mouse.move(...from);
    await page.mouse.down();
    try {
      await page.mouse.move(...to, { steps: 24 });
      await delay(150);
    } finally {
      await page.mouse.up();
    }
    await moveOffList(observation.maps);
    await settle();
    return {
      executed: true,
      fromEnd,
      toEnd,
      fromNative: [(left + right) / 2, yAt(fromEnd)],
      toNative: [(left + right) / 2, yAt(toEnd)],
      scrollbar,
    };
  };
  const selectVisibleRow = async (observation, row) => {
    const before = observation.maps.list.selection,
      height = observation.maps.list.itemHeight;
    assert(Number.isFinite(height) && height > 0, 'Actual native map row height required');
    await ownerIdle();
    await click(
      observation.maps.rect[0] + (observation.maps.rect[2] - observation.maps.rect[0] - 20) / 2,
      observation.maps.rect[1] + 2 + height * (row + 0.5),
    );
    await settle();
    const after = await inspect();
    return {
      before,
      after: after.maps.list.selection,
      changed: before !== after.maps.list.selection,
      inRange: after.maps.list.selection >= 0 && after.maps.list.selection < after.maps.list.count,
      observation: after,
    };
  };
  try {
    const original = await inspect();
    summary.initial = original;
    assert.equal(original.types.list.count, 3, 'Three actual native game types required');
    await persist();
    for (let index = 0; index < 3; index++) {
      const mode = { index, expectedCount: summary.expectedCounts[index], completed: false };
      summary.modes.push(mode);
      try {
        let current = await selectMode(index);
        mode.nativeCount = current.maps.list.count;
        mode.countMatches = mode.nativeCount === mode.expectedCount;
        mode.gameTypeSelection = current.types.list.selection;
        await moveOffList(current.maps);
        mode.top = await capture(`map-mode-${index}-top`, current);
        const row = current.maps.list.selection === 1 ? 2 : 1;
        mode.clickSelection = await selectVisibleRow(current, row);
        mode.clickScreenshot = await capture(`map-mode-${index}-click`, mode.clickSelection.observation);
        current = mode.clickSelection.observation;
        const beforeWheelRaster = await raster(current.maps.rect);
        mode.wheelBefore = current.maps.list;
        await wheel(current.maps, 640);
        const wheeled = await inspect();
        mode.wheelAfter = wheeled.maps.list;
        mode.wheel = await capture(`map-mode-${index}-wheel`, wheeled);
        mode.wheelRasterChange = difference(beforeWheelRaster, mode.wheel.raster);
        await wheel(wheeled.maps, -640);
        current = await inspect();
        mode.scrollbarBefore = current.maps.list;
        const beforeScrollbarRaster = await raster(current.maps.rect);
        mode.scrollbarDrag = await dragScrollbar(current, 'top', 'bottom');
        const bottom = await inspect();
        mode.scrollbarAfter = bottom.maps.list;
        mode.bottom = await capture(`map-mode-${index}-bottom`, bottom);
        mode.scrollbarRasterChange = difference(beforeScrollbarRaster, mode.bottom.raster);
        mode.bottomClickSelection = await selectVisibleRow(bottom, 1);
        mode.bottomClickScreenshot = await capture(
          `map-mode-${index}-bottom-click`,
          mode.bottomClickSelection.observation,
        );
        mode.completed =
          mode.countMatches &&
          mode.clickSelection.changed &&
          mode.clickSelection.inRange &&
          mode.scrollbarDrag.executed &&
          mode.wheelRasterChange.changedSamples > 0 &&
          mode.scrollbarRasterChange.changedSamples > 0;
        // Restore the actual thumb with the same user drag before the next mode.
        mode.scrollbarRestore = await dragScrollbar(await inspect(), 'bottom', 'top');
      } catch (error) {
        mode.error = String(error.stack || error);
        mode.completed = false;
      }
      await record('native-map-mode', {
        index,
        expectedCount: mode.expectedCount,
        nativeCount: mode.nativeCount,
        countMatches: mode.countMatches,
        clickSelection: mode.clickSelection,
        wheelRasterChange: mode.wheelRasterChange,
        scrollbarRasterChange: mode.scrollbarRasterChange,
        completed: mode.completed,
        error: mode.error,
      });
      await persist();
    }
    summary.restoredGameType = await selectMode(original.types.list.selection);
    summary.completed = summary.modes.length === 3 && summary.modes.every((mode) => mode.completed);
  } catch (error) {
    summary.error = String(error.stack || error);
  }
  summary.finishedAt = new Date().toISOString();
  await persist();
  await record('native-map-dialog-complete', {
    completed: summary.completed,
    counts: summary.modes.map((mode) => mode.nativeCount),
    evidence: 'native-maps-summary.json',
    error: summary.error,
  });
  return summary;
}
