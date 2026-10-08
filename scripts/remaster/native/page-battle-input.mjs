import { setTimeout as delay } from 'node:timers/promises';
import { tsImport } from 'tsx/esm/api';

const supportedHash = '7b8a068535d6af06845edf95ae829b113d00c02909330e16f197426cd7db94b6';
const sidebar = 0x87f7e8,
  strips = sidebar + 0x1544,
  stripSize = 0xf94;

/** Combat effects that the native local-player visibility and camera actually expose. */
export function observePageCombat(state, zFactor) {
  if (!state?.view || !state.effects || !state.shroud || !Number.isFinite(zFactor))
    return { frame: state?.frame ?? null, effects: [], visible: 0, inView: 0 };
  const width = state.sidebar?.frame.width ?? 0,
    height = state.sidebar?.frame.height ?? 0,
    side = state.sidebar?.layout.sidebar,
    bounds = {
      left: side?.x === 0 ? side.width : 0,
      top: 0,
      right: side?.x > 0 ? side.x : width,
      bottom: state.sidebar?.layout.commandBar?.y ?? height,
    };
  const shroud = state.shroud;
  const effects = [];
  // Policy belongs to the pinned YR acceptance tool, not the generic bridge.
  // These are weapon Anim references in the supplied original rules. Require
  // a resolved native animation; smoke, impacts and building loops do not count.
  const muzzles = (state.effects.anims ?? []).filter(
    (anim) =>
      ['GUNFIRE', 'APMUZZLE', 'VTMUZZLE'].includes(anim.type) &&
      anim.buildingAnim === false &&
      anim.invisible === false &&
      Number.isInteger(anim.frameCount) &&
      anim.frameCount > 0 &&
      Number.isSafeInteger(anim.id) &&
      anim.id > 0 &&
      Number.isSafeInteger(anim.uid) &&
      anim.uid >= 0,
  );
  const add = (kind, object, p, id = object.id ?? null) => {
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return;
    // Match MapClass::IsLocationShrouded and the actual renderer's flat mask:
    // a raised point covers earlier X/Y cells, with two cells at odd levels.
    // Keep the acceptance stricter than "mapped": fogged cells still do not pass.
    const level = Math.trunc(p.z / 104),
      cellX = Math.trunc(p.x / 256),
      cellY = Math.trunc(p.y / 256),
      shift = Math.trunc(level / 2) + Number(!!(level & 1));
    const flatCells = [{ x: cellX - shift, y: cellY - shift }];
    if (level & 1) flatCells.push({ x: cellX - shift + 1, y: cellY - shift + 1 });
    const cellEvidence = {
      level,
      cells: flatCells.map((cell) => {
        const x = cell.x - shroud.originX,
          y = cell.y - shroud.originY;
        return {
          ...cell,
          state: x >= 0 && y >= 0 && x < shroud.width && y < shroud.height ? shroud.cells[y * shroud.width + x] : 0xff,
        };
      }),
    };
    const visible = cellEvidence.cells.some((cell) => cell.state === 2);
    if (!visible) return;
    const worldPixel = {
      x: Math.trunc((30 * (p.x - p.y)) / 256),
      y: Math.trunc((15 * (p.x + p.y)) / 256) - Math.trunc(p.z * zFactor + (p.z >= 728 ? 1 : 0) + 0.5),
    };
    const pixel = { x: worldPixel.x - state.view.x, y: worldPixel.y - state.view.y };
    effects.push({
      kind,
      id,
      uid: object.uid ?? null,
      type: object.type ?? null,
      world: { x: p.x, y: p.y, z: p.z },
      worldPixel,
      pixel,
      visibleCell: true,
      flatCells,
      cellEvidence,
      inView: pixel.x >= bounds.left && pixel.x < bounds.right && pixel.y >= bounds.top && pixel.y < bounds.bottom,
    });
  };
  for (const bullet of state.effects.bullets) if (!bullet.inviso) add('bullet', bullet, bullet);
  for (const laser of state.effects.lasers) {
    add('laser-source', laser, laser.source);
    add('laser-target', laser, laser.target);
  }
  for (const bolt of state.effects.electricBolts) {
    add('bolt-source', bolt, bolt.source);
    add('bolt-target', bolt, bolt.target);
  }
  for (const beam of state.effects.radBeams ?? []) {
    add('beam-source', beam, beam.source);
    add('beam-target', beam, beam.target);
  }
  for (const wave of state.effects.waves ?? []) {
    add('wave-source', wave, wave.source);
    add('wave-target', wave, wave.target);
  }
  for (const anim of muzzles) add('muzzle', anim, anim);
  return {
    frame: state.frame,
    view: state.view,
    bounds,
    effects,
    muzzleKeys: (state.effects.anims ?? [])
      .filter((anim) => Number.isSafeInteger(anim.id) && anim.id > 0 && Number.isSafeInteger(anim.uid) && anim.uid >= 0)
      .map((anim) => `${anim.id}:${anim.uid}`),
    animsTruncated: state.effects.animsTruncated === true,
    visible: effects.length,
    inView: effects.filter((effect) => effect.inView).length,
  };
}

/** Observe the real AI battle and bring it into view with ordinary arrow keys only. */
export async function focusPageCombat({ vm, readBytes, getLatestRenderState, seconds = 120 }) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 300)
    throw new Error('Combat focus wait must be in (0,300] seconds');
  const zFactor = Buffer.from(await readBytes(0xb0cd48, 8)).readDoubleLE();
  if (!Number.isFinite(zFactor) || zFactor <= 0 || zFactor > 4) throw new Error('Invalid native height projection');
  const { keyLParam, virtualKey } = await tsImport('../../../src/ui/pages/game/input.ts', import.meta.url);
  // The integrated harness supplies its latest result from the one60Hz poll.
  const readState = getLatestRenderState ?? (() => vm.getRenderState());
  const startedAt = performance.now(),
    deadline = startedAt + seconds * 1000;
  const report = {
    met: false,
    input: 'ordinary arrow keys only',
    zFactor,
    before: null,
    after: null,
    actions: [],
    observations: [],
  };
  let target = null,
    consecutive = 0,
    lastFrame = null;
  const pixelsPerMs = { x: 1, y: 1 };
  const hold = async (code, ms) => {
    const event = { code, key: code, location: 0, ctrlKey: false, altKey: false, metaKey: false },
      vk = virtualKey(event);
    vm.setKeyState(vk, true);
    vm.postMessage(0x100, vk, keyLParam(event, false, false));
    try {
      await delay(ms);
    } finally {
      vm.setKeyState(vk, false);
      vm.postMessage(0x101, vk, keyLParam(event, true, true));
    }
    await delay(100);
  };
  try {
    while (performance.now() < deadline) {
      const state = await readState();
      if (!state?.view) {
        await delay(100);
        continue;
      }
      report.before ??= { frame: state.frame, view: state.view };
      const combat = observePageCombat(state, zFactor);
      if (!combat.bounds || combat.bounds.right <= combat.bounds.left || combat.bounds.bottom <= combat.bounds.top) {
        await delay(100);
        continue;
      }
      if (combat.visible) {
        if (report.observations.length < 120)
          report.observations.push({ seconds: (performance.now() - startedAt) / 1000, ...combat });
        console.log(
          'page-combat-focus',
          JSON.stringify({
            frame: state.frame,
            view: state.view,
            visible: combat.visible,
            inView: combat.inView,
            effects: combat.effects.slice(0, 8),
          }),
        );
        if (combat.inView) {
          if (lastFrame !== state.frame) consecutive++;
          lastFrame = state.frame;
          if (consecutive >= 3) {
            report.met = true;
            report.after = { frame: state.frame, view: state.view, combat };
            return report;
          }
          await delay(100);
          continue;
        }
        consecutive = 0;
        // Keep following the nearest observed visible combat, without revealing
        // shrouded cells or issuing any command to a unit.
        target = combat.effects.reduce((best, effect) => {
          const distance = Math.hypot(
            effect.pixel.x - (combat.bounds.left + combat.bounds.right) / 2,
            effect.pixel.y - (combat.bounds.top + combat.bounds.bottom) / 2,
          );
          return !best || distance < best.distance ? { effect, distance } : best;
        }, null).effect;
      }
      if (target) {
        const centerX = (combat.bounds.left + combat.bounds.right) / 2,
          centerY = (combat.bounds.top + combat.bounds.bottom) / 2,
          dx = target.worldPixel.x - state.view.x - centerX,
          dy = target.worldPixel.y - state.view.y - centerY;
        const horizontal = Math.abs(dx) > Math.abs(dy),
          delta = horizontal ? dx : dy;
        if (Math.abs(delta) > 32) {
          const code = horizontal ? (delta > 0 ? 'ArrowRight' : 'ArrowLeft') : delta > 0 ? 'ArrowDown' : 'ArrowUp';
          const action = {
            code,
            ms: Math.min(500, Math.max(80, (Math.abs(delta) * 0.7) / pixelsPerMs[horizontal ? 'x' : 'y'])),
            before: { frame: state.frame, view: state.view },
            target,
          };
          // Centre the logical cursor so it cannot add an edge-scroll direction.
          vm.setCursorPosition(Math.round(centerX), Math.round(centerY));
          await hold(code, action.ms);
          const after = await readState();
          action.after = after ? { frame: after.frame, view: after.view } : null;
          report.actions.push(action);
          if (after?.view) {
            const actual = Math.abs(horizontal ? after.view.x - state.view.x : after.view.y - state.view.y);
            if (actual > 0) pixelsPerMs[horizontal ? 'x' : 'y'] = actual / action.ms;
          }
          if (action.after?.view && action.after.view.x === state.view.x && action.after.view.y === state.view.y)
            target = null;
          continue;
        }
        target = null;
      }
      await delay(100);
    }
    report.error = 'No actual local-visible weapon effects persisted in tactical view within the bounded wait';
  } finally {
    for (const vk of [0x25, 0x26, 0x27, 0x28]) vm.setKeyState(vk, false);
    report.durationSeconds = (performance.now() - startedAt) / 1000;
  }
  return report;
}

/**
 * A short player-input acceptance sequence on the actual page VmShell. Observers
 * may read native memory, but every mutation goes through the page's input RPC.
 * This starts one production item; it does not automate combat or build a base.
 */
export async function runPageBattleInput({ vm, readBytes, getInputState, capture, hello }) {
  if (!hello?.exe?.verified || hello.exe.sha256 !== supportedHash)
    throw new Error('Battle observations require the supported original YR executable');
  const { keyLParam, virtualKey, win32CharacterCode } = await tsImport(
    '../../../src/ui/pages/game/input.ts',
    import.meta.url,
  );
  const report = { startedAt: performance.now(), inputOnlyMutations: true, steps: [], met: false };
  const record = (name, proof) => {
    const entry = { name, at: performance.now(), ...proof };
    report.steps.push(entry);
    console.log('page-battle-input', JSON.stringify(entry));
    return entry;
  };
  const memory = async (address, length) => Buffer.from(await readBytes(address, length));
  const u32 = async (address) => (await memory(address, 4)).readUInt32LE();
  const peek = async () => {
    const until = performance.now() + 8000;
    do {
      const state = await vm.getCommandState();
      if (state && state.localHouse >= 0 && state.view) return state;
      await delay(50);
    } while (performance.now() < until);
    throw new Error('No live local battle command state after command-reader bootstrap');
  };
  const wait = async (label, check, timeout = 8000) => {
    const until = performance.now() + timeout;
    let last = null;
    while (performance.now() < until) {
      last = await peek();
      const proof = await check(last);
      if (proof) return { state: last, proof };
      await delay(50);
    }
    throw new Error(
      `${label} did not reach the native expected state: ${JSON.stringify(
        last ? { frame: last.frame, view: last.view, owned: local(last), activeTab: last.sidebar?.activeTab } : null,
      )}`,
    );
  };
  const local = (state) => state.objects.filter((obj) => obj.owner === state.localHouse && obj.health > 0);
  const mobile = (state) => local(state).filter((obj) => obj.kind === 'vehicle' || obj.kind === 'infantry');
  const zFactor = (await memory(0xb0cd48, 8)).readDoubleLE();
  if (!Number.isFinite(zFactor) || zFactor <= 0 || zFactor > 4) throw new Error('Invalid native height projection');
  const project = (object, view) => ({
    x: Math.trunc((30 * (object.x - object.y)) / 256) - view.x,
    y:
      Math.trunc((15 * (object.x + object.y)) / 256) -
      Math.trunc(object.z * zFactor + (object.z >= 728 ? 1 : 0) + 0.5) -
      view.y,
  });
  const inTactical = (p, state, margin = 24) => {
    const bounds = state.sidebar?.layout.sidebar;
    const right = bounds && bounds.x > 0 ? bounds.x : hello.surface.width - 168;
    return p.x >= margin && p.x < right - margin && p.y >= margin && p.y < hello.surface.height - 60;
  };
  const point = (x, y) => (((Math.round(y) & 0xffff) << 16) | (Math.round(x) & 0xffff)) >>> 0;
  const move = (x, y, flags = 0) => {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= hello.surface.width || y >= hello.surface.height)
      throw new Error(`Input outside native frame: ${x},${y}`);
    vm.setCursorPosition(x, y);
    vm.postMessage(0x200, flags, point(x, y));
  };
  const click = async (x, y, button = 'left', hold = 80) => {
    const right = button === 'right',
      vk = right ? 2 : 1,
      flag = right ? 2 : 1;
    move(x, y);
    vm.setKeyState(vk, true);
    vm.postMessage(right ? 0x204 : 0x201, flag, point(x, y));
    try {
      if (hold) await delay(hold);
    } finally {
      vm.setKeyState(vk, false);
      vm.postMessage(right ? 0x205 : 0x202, 0, point(x, y));
    }
    await delay(180);
  };
  const key = async (code, keyValue, hold = 100) => {
    const event = { code, key: keyValue, location: 0, ctrlKey: false, altKey: false, metaKey: false };
    const vk = virtualKey(event);
    if (!vk) throw new Error(`Unsupported ordinary key ${code}`);
    vm.setKeyState(vk, true);
    vm.postMessage(0x100, vk, keyLParam(event, false, false));
    const character = win32CharacterCode(event);
    if (character !== null) vm.postMessage(0x102, character, keyLParam(event, false, false));
    try {
      await delay(hold);
    } finally {
      vm.setKeyState(vk, false);
      vm.postMessage(0x101, vk, keyLParam(event, true, true));
    }
    await delay(150);
  };
  const select = async (uid, label) => {
    const state = await peek(),
      object = local(state).find((obj) => obj.uid === uid);
    if (!object) throw new Error(`Local unit ${uid} no longer exists`);
    const p = project(object, state.view);
    if (!inTactical(p, state)) throw new Error(`Local unit ${uid} is outside tactical view`);
    await click(p.x, p.y);
    const after = await wait(label, (s) => local(s).find((obj) => obj.uid === uid && obj.selected));
    return { before: object, point: p, after: after.proof, frame: after.state.frame };
  };
  const shot = async (label) => {
    if (capture) await capture(`battle-${label}`);
  };
  const factory = async (cameo, tab) => {
    const entry = strips + tab * stripSize + 0x58 + cameo.index * 0x34;
    const pointer = await u32(entry + 0xc);
    if (!pointer) return { pointer: 0, progress: null, object: 0, running: false, type: null };
    if (pointer < 0x10000 || pointer % 4) throw new Error('Invalid observed native factory pointer');
    const raw = await memory(pointer, 0x74),
      object = raw.readUInt32LE(0x58);
    let type = null;
    if (object) {
      const typePointer = await u32(object + 0x520);
      type = (await memory(typePointer + 0x24, 24)).toString('ascii').split('\0')[0];
    }
    return {
      pointer,
      progress: raw.readInt32LE(0x24),
      running: raw.readInt32LE(0x38) !== 0,
      object,
      special: raw.readInt32LE(0x68),
      hold: raw[0x70] !== 0,
      type,
    };
  };
  try {
    if ((await getInputState()).modal) throw new Error('Resume the native battle before input acceptance');
    let state = await peek();
    if (state.sidebar?.frame) hello = { ...hello, surface: { ...hello.surface, ...state.sidebar.frame } };
    await shot('before');
    const candidates = mobile(state).filter(
      (obj) => !/^(AMCV|MCV|SMCV|PCV)$/.test(obj.type) && inTactical(project(obj, state.view), state),
    );
    const target = candidates.find((obj) => obj.kind === 'vehicle') ?? candidates[0];
    if (!target) throw new Error('No visible owned ground unit for selection/move acceptance');
    const selected = await select(target.uid, 'left click selection');
    record('left-click-select', { ...selected, verified: true });
    await shot('selected');

    const initial = selected.after,
      attempts = [];
    let moved = null;
    // The player's control option chooses whether right or left click orders a
    // selected unit. Try both genuine clicks; observe the original game result.
    for (const button of ['right', 'left']) {
      await select(target.uid, `reselect before ${button} ground click`);
      state = await peek();
      const object = local(state).find((obj) => obj.uid === target.uid),
        p = project(object, state.view);
      const destinations = [
        { x: p.x + 72, y: p.y + 20 },
        { x: p.x - 72, y: p.y + 20 },
        { x: p.x + 30, y: p.y - 40 },
      ];
      const destination = destinations.find((d) => inTactical(d, state));
      if (!destination) throw new Error('No visible ground point near the selected unit');
      await click(destination.x, destination.y, button);
      const deadline = performance.now() + 3500;
      let last = null;
      while (performance.now() < deadline) {
        state = await peek();
        last = local(state).find((obj) => obj.uid === target.uid);
        if (!last) throw new Error('Move-test unit was removed by the live battle');
        const changedDestination =
          last.destination !== null && JSON.stringify(last.destination) !== JSON.stringify(initial.destination);
        const changedPosition = Math.hypot(last.x - initial.x, last.y - initial.y) >= 32;
        if (changedDestination || changedPosition) {
          moved = { button, point: destination, before: initial, after: last, frame: state.frame };
          break;
        }
        await delay(75);
      }
      attempts.push({ button, point: destination, last });
      if (moved) break;
    }
    if (!moved)
      throw new Error(`Ground input did not change the selected unit order/position: ${JSON.stringify(attempts)}`);
    record('ground-move', { ...moved, attempts, verified: true });
    await shot('moved');

    state = await peek();
    const visible = mobile(state).filter((obj) => inTactical(project(obj, state.view), state));
    const selectedBeforeDrag = mobile(state).filter((obj) => obj.selected);
    const previouslySelected = new Set(selectedBeforeDrag.map((obj) => obj.uid));
    if (visible.length < 2) throw new Error('Fewer than two visible owned ground units for drag acceptance');
    const points = visible.map((obj) => ({ uid: obj.uid, ...project(obj, state.view) }));
    const start = { x: Math.min(...points.map((p) => p.x)) - 18, y: Math.min(...points.map((p) => p.y)) - 24 },
      finish = { x: Math.max(...points.map((p) => p.x)) + 18, y: Math.max(...points.map((p) => p.y)) + 18 };
    if (!inTactical(start, state, 1) || !inTactical(finish, state, 1))
      throw new Error('Observed group bounds leave tactical view');
    move(start.x, start.y);
    vm.setKeyState(1, true);
    vm.postMessage(0x201, 1, point(start.x, start.y));
    try {
      for (let i = 1; i <= 12; i++) {
        move(start.x + ((finish.x - start.x) * i) / 12, start.y + ((finish.y - start.y) * i) / 12, 1);
        await delay(25);
      }
    } finally {
      vm.setKeyState(1, false);
      vm.postMessage(0x202, 0, point(finish.x, finish.y));
    }
    const drag = await wait('drag multiple selection', (s) => {
      const group = mobile(s).filter((obj) => obj.selected);
      return group.length >= 2 && group.some((obj) => !previouslySelected.has(obj.uid)) ? group : null;
    });
    record('drag-select', {
      start,
      finish,
      candidates: points,
      selectedBefore: selectedBeforeDrag,
      selected: drag.proof,
      frame: drag.state.frame,
      verified: true,
    });
    await shot('dragged');

    state = await peek();
    let yard = local(state).find((obj) => obj.kind === 'building' && /CNST$/.test(obj.type));
    if (!yard) {
      const mcv = mobile(state).find((obj) => /^(AMCV|MCV|SMCV|PCV)$/.test(obj.type));
      if (!mcv) throw new Error('No local MCV or construction yard for sidebar production acceptance');
      const deploymentSelection = await select(mcv.uid, 'select MCV for sidebar availability');
      await key('KeyD', 'd');
      const deployed = await wait('MCV deployment', (s) =>
        local(s).find((obj) => obj.kind === 'building' && /CNST$/.test(obj.type)),
      );
      yard = deployed.proof;
      record('deploy-mcv-for-production', {
        selection: deploymentSelection,
        yard,
        frame: deployed.state.frame,
        verified: true,
      });
    }
    state = await peek();
    if (!state.sidebar?.layout.tabs[0]) throw new Error('No native sidebar building tab');
    const tab = state.sidebar.layout.tabs[0];
    await click(tab.x + tab.width / 2, tab.y + tab.height / 2);
    const readyTab = await wait('building tab', (s) => s.sidebar?.activeTab === 0 && s.sidebar.cameos.length > 0);
    const cameo =
      readyTab.state.sidebar.cameos.find((item) => /^(GAPOWR|NAPOWR|YAPOWR)$/.test(item.id)) ??
      readyTab.state.sidebar.cameos.find((item) => item.kind === 'building' && !item.darkened);
    if (!cameo) throw new Error('No visible buildable building cameo');
    const beforeFactory = await factory(cameo, 0);
    if (beforeFactory.pointer) throw new Error('Production acceptance requires an initially idle observed cameo');
    const size = readyTab.state.sidebar.layout.cameo;
    const clickPoint = { x: cameo.x + size.width / 2, y: cameo.y + size.height / 2 };
    await click(clickPoint.x, clickPoint.y);
    const samples = [];
    let produced = null;
    const until = performance.now() + 12000;
    while (performance.now() < until) {
      const current = await factory(cameo, 0);
      if (samples.length < 40) samples.push({ at: performance.now(), frame: await u32(0xa8ed84), ...current });
      if (current.pointer && current.object && current.type === cameo.id && (current.running || current.progress > 0)) {
        produced = current;
        break;
      }
      await delay(100);
    }
    if (!produced) throw new Error(`Cameo click did not start native factory production: ${JSON.stringify(samples)}`);
    record('cameo-production', {
      id: cameo.id,
      point: clickPoint,
      before: beforeFactory,
      after: produced,
      samples,
      verified: true,
    });
    await shot('production');

    move(hello.surface.width / 2, hello.surface.height / 2);
    state = await peek();
    const viewBefore = state.view,
      scrollAttempts = [];
    let scrolled = null;
    for (const code of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      await key(code, code, 600);
      const after = await peek();
      scrollAttempts.push({ code, view: after.view, frame: after.frame });
      if (after.view.x !== viewBefore.x || after.view.y !== viewBefore.y) {
        scrolled = after;
        break;
      }
    }
    if (!scrolled) throw new Error(`Arrow input did not move native tactical view: ${JSON.stringify(scrollAttempts)}`);
    record('arrow-scroll', {
      before: viewBefore,
      after: scrolled.view,
      frame: scrolled.frame,
      attempts: scrollAttempts,
      verified: true,
    });
    await shot('scrolled');

    await key('Escape', 'Escape');
    let menu = null;
    const menuUntil = performance.now() + 8000;
    while (performance.now() < menuUntil) {
      const s = await getInputState();
      if (s.modal && s.controls.some((c) => c.visible && c.enabled && /resume|return.*game|continue/i.test(c.text))) {
        menu = s;
        break;
      }
      await delay(100);
    }
    if (!menu) throw new Error('Escape did not open the actual native options menu');
    const resume = menu.controls.find((c) => c.visible && c.enabled && /resume|return.*game|continue/i.test(c.text));
    record('escape-options', {
      modal: menu.modal,
      dialogHwnd: menu.dialogHwnd,
      resume,
      lastKey: menu.lastKeyVirtualKey,
      verified: true,
    });
    await shot('options');
    // The original menu animation exposes controls before it accepts presses.
    await delay(1200);
    await click((resume.rect[0] + resume.rect[2]) / 2, (resume.rect[1] + resume.rect[3]) / 2);
    const resumeUntil = performance.now() + 8000;
    let closed = null;
    while (performance.now() < resumeUntil) {
      const s = await getInputState();
      if (!s.modal) {
        closed = s;
        break;
      }
      await delay(100);
    }
    if (!closed) throw new Error('Resume click did not close the actual options menu');
    const resumed = await peek(),
      progressing = await wait('resume logic advancement', (s) => (s.frame > resumed.frame + 5 ? s.frame : null));
    record('resume-close', {
      modal: closed.modal,
      beforeFrame: resumed.frame,
      afterFrame: progressing.proof,
      verified: true,
    });
    await shot('resumed');
    report.met = true;
  } catch (error) {
    report.error = String(error.stack || error);
    report.inputAtFailure = await getInputState().catch(() => null);
    report.stateAtFailure = await vm.getCommandState().catch(() => null);
    await shot('failure').catch(() => undefined);
    console.error('page-battle-input-failed', report.error);
  } finally {
    for (const vk of [1, 2, 0x1b, 0x25, 0x26, 0x27, 0x28, 0x44]) vm.setKeyState(vk, false);
    report.finishedAt = performance.now();
    report.durationMs = report.finishedAt - report.startedAt;
  }
  return report;
}
