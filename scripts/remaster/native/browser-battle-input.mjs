import { setTimeout as delay } from 'node:timers/promises';

// Read-only observations for the pinned original YR 1.001 image. The browser
// owns every input mutation; these addresses never provide an input shortcut.
const sidebar = 0x87f7e8;
const strips = sidebar + 0x1544;
const stripSize = 0xf94;
const local = (state) => state.objects.filter((obj) => obj.owner === state.localHouse && obj.health > 0);
const mobile = (state) => local(state).filter((obj) => obj.kind === 'vehicle' || obj.kind === 'infantry');
const usable = (control) => control.visible && control.enabled;
const control = (state, match) =>
  state.controls?.find(
    (item) => usable(item) && (typeof match === 'number' ? item.id === match : match.test(item.text)),
  );

// Outcome labels are observations only. Original house metadata and screenshot
// review remain separate; a generic Continue/score label cannot establish a win.
export function readBrowserEndingLabels(state) {
  const controls = state.controls?.filter(usable) ?? [];
  const defeat = controls.filter((item) =>
    /^(?:GUI:)?(?:Defeat|You\s*Lose|Mission\s*Failed|战败|戰敗|败北|敗北|任务失败|任務失敗)[.!]?$/i.test(item.text),
  );
  const victory = controls.filter((item) =>
    /^(?:GUI:)?(?:Victory|You\s*Win|Mission\s*Accomplished|胜利|勝利|任务完成|任務完成)[.!]?$/i.test(item.text),
  );
  return {
    defeat,
    victory,
    labelledOutcome:
      defeat.length > 0 && !victory.length ? 'defeat' : victory.length > 0 && !defeat.length ? 'victory' : null,
  };
}

function browserContext(api) {
  const { page, shot } = api;
  const guard = async () => api.ownerIdle?.();
  const observe =
    (fn) =>
    async (...args) => {
      await guard();
      const value = await fn(...args);
      // A hold or cancellation can arrive during an asynchronous observation.
      await guard();
      return value;
    };
  const click = async (...args) => {
    await guard();
    return api.click(...args);
  };
  const point = observe(api.point);
  const commandState = observe(api.commandState);
  const readBytes = observe(api.readBytes);
  const inputState = observe(api.inputState);
  const report = {
    startedAt: performance.now(),
    input: 'trusted browser mouse and keyboard events',
    steps: [],
    met: false,
  };
  const record = async (name, proof) => {
    const entry = { name, at: performance.now(), ...proof };
    report.steps.push(entry);
    await api.record?.(name, proof);
    return entry;
  };
  const memory = async (address, length) => Buffer.from(await readBytes(address, length));
  const u32 = async (address) => (await memory(address, 4)).readUInt32LE();
  const wait = async (label, observe, timeout = 8000) => {
    const until = performance.now() + timeout;
    let last = null;
    while (performance.now() < until) {
      await guard();
      last = await observe();
      await guard();
      if (last) return last;
      await delay(75);
    }
    throw new Error(`${label} did not reach the expected native state within ${timeout} ms`);
  };
  const peek = () =>
    wait('live local battle state', async () => {
      const state = await commandState();
      return state?.localHouse >= 0 && state.view ? state : null;
    });
  const stateWait = (label, check, timeout = 8000) =>
    wait(
      label,
      async () => {
        const state = await commandState();
        if (!state?.view) return null;
        const proof = await check(state);
        return proof ? { state, proof } : null;
      },
      timeout,
    );
  const pagePoint = async (x, y) => {
    const value = await point(Math.round(x), Math.round(y));
    return Array.isArray(value) ? { x: value[0], y: value[1] } : value;
  };
  const move = async (x, y, steps = 1) => {
    const p = await pagePoint(x, y);
    await guard();
    await page.mouse.move(p.x, p.y, { steps });
  };
  const ensureKeyboardFocus = async () => {
    await guard();
    const focus = () =>
      page.evaluate(() => ({
        canvasFocused: document.activeElement === document.querySelector('#screen'),
        activeElement: document.activeElement?.id ?? null,
        documentFocused: document.hasFocus(),
      }));
    const before = await focus();
    if (before.canvasFocused && before.documentFocused) return;
    const nativeBefore = await inputState();
    const toggle = page.locator('#vm-controls-toggle');
    if ((await toggle.getAttribute('aria-expanded')) === 'true') {
      await guard();
      await toggle.click();
    }
    const bounds = await page.locator('#screen').boundingBox();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0)
      throw new Error('Game canvas is unavailable for real focus');
    // A toolbar button retains DOM focus after navigation. Real pointerdown
    // invokes the page's normal canvas focus handler; no DOM focus shortcut is
    // used. Right-click also cancels a pending order/mode, so selection-sensitive
    // callers must establish their selection before issuing their next command.
    const at = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    await guard();
    await page.mouse.move(at.x, at.y);
    await guard();
    await page.mouse.down({ button: 'right' });
    try {
      await delay(80);
    } finally {
      await page.mouse.up({ button: 'right' });
    }
    await delay(100);
    const after = await focus();
    const nativeAfter = await inputState();
    await record('restore-keyboard-focus', {
      before,
      after,
      point: at,
      input: 'trusted browser right-click on exposed game canvas, held 80 ms',
      modeEffect: 'Ordinary native right-click may cancel a pending mode and clear selection',
      nativeBefore: { acceptedInputs: nativeBefore.acceptedInputs, lastKeyVirtualKey: nativeBefore.lastKeyVirtualKey },
      nativeAfter: { acceptedInputs: nativeAfter.acceptedInputs, lastKeyVirtualKey: nativeAfter.lastKeyVirtualKey },
      verified: after.canvasFocused && after.documentFocused,
    });
    if (!after.canvasFocused || !after.documentFocused)
      throw new Error('Trusted pointer input did not focus game canvas');
  };
  const key = async (value, hold = 80) => {
    await ensureKeyboardFocus();
    await guard();
    await page.keyboard.down(value);
    try {
      await delay(hold);
    } finally {
      await page.keyboard.up(value);
    }
    await delay(100);
  };
  const clickControl = async (item, mode = 'no-move') => {
    // YR exposes native controls while their entering animation still ignores
    // clicks. Waiting here is a menu readiness boundary, not an input repair.
    await delay(1200);
    await click((item.rect[0] + item.rect[2]) / 2, (item.rect[1] + item.rect[3]) / 2, mode, 'left');
  };
  const diagnostic = observe(() =>
    page.evaluate(() => {
      const bridge = window.__hdBridge;
      return {
        enabled: bridge?.diagnostics?.enabled ?? null,
        shown: bridge?.diagnostics?.shown ?? null,
        timeline: bridge?.timeline ?? null,
        shellPage: document.querySelector('#screen')?.dataset.shellPage ?? null,
      };
    }),
  );
  const finish = () => {
    report.finishedAt = performance.now();
    report.durationMs = report.finishedAt - report.startedAt;
    return report;
  };
  return {
    ...api,
    guard,
    click,
    point,
    commandState,
    readBytes,
    inputState,
    report,
    record,
    memory,
    u32,
    wait,
    peek,
    stateWait,
    move,
    ensureKeyboardFocus,
    key,
    clickControl,
    diagnostic,
    finish,
    shot: async (label) => {
      await guard();
      const screenshot = await shot?.(`battle-${label}`);
      await guard();
      return screenshot;
    },
  };
}

async function factory(h, cameo, tab = 0) {
  const entry = strips + tab * stripSize + 0x58 + cameo.index * 0x34;
  const pointer = await h.u32(entry + 0xc);
  if (!pointer) return { pointer: 0, progress: null, object: 0, running: false, type: null };
  if (pointer < 0x10000 || pointer % 4) throw new Error('Invalid observed native factory pointer');
  const raw = await h.memory(pointer, 0x74);
  const object = raw.readUInt32LE(0x58);
  let type = null;
  if (object) {
    const typePointer = await h.u32(object + 0x520);
    type = (await h.memory(typePointer + 0x24, 24)).toString('ascii').split('\0')[0];
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
}

/** Player actions before the separate one-minute battle measurement. */
export async function runBrowserBattleInput(api) {
  const h = browserContext(api);
  const { page, click, record, peek, stateWait, inputState, shot, wait, commandState } = h;
  try {
    if ((await inputState()).modal) throw new Error('Native battle must be resumed before browser input acceptance');
    const zFactor = (await h.memory(0xb0cd48, 8)).readDoubleLE();
    if (!Number.isFinite(zFactor) || zFactor <= 0 || zFactor > 4) throw new Error('Invalid native height projection');
    const project = (object, view) => ({
      x: Math.trunc((30 * (object.x - object.y)) / 256) - view.x,
      y:
        Math.trunc((15 * (object.x + object.y)) / 256) -
        Math.trunc(object.z * zFactor + (object.z >= 728 ? 1 : 0) + 0.5) -
        view.y,
    });
    const inTactical = (p, state, margin = 24) => {
      const side = state.sidebar?.layout.sidebar;
      const frame = state.sidebar?.frame;
      if (!frame) return false;
      const left = side?.x === 0 ? side.width : 0;
      const right = side?.x > 0 ? side.x : frame.width;
      const bottom = state.sidebar?.layout.commandBar?.y ?? frame.height;
      return p.x >= left + margin && p.x < right - margin && p.y >= margin && p.y < bottom - margin;
    };
    const select = async (uid, mode = 'no-move', forceClick = true) => {
      const before = await peek();
      const object = local(before).find((obj) => obj.uid === uid);
      if (!object) throw new Error(`Owned object ${uid} no longer exists`);
      const p = project(object, before.view);
      if (!inTactical(p, before)) throw new Error(`Owned object ${uid} leaves tactical view before selection`);
      // Clicking a unit already in a selected group retains that whole group.
      // Cancel on empty tactical ground: right-clicking the unit itself invokes
      // its contextual action (notably MCV deployment), rather than deselection.
      const selectedBefore = local(before).filter((obj) => obj.selected);
      if (!forceClick && selectedBefore.length === 1 && selectedBefore[0].uid === uid)
        return {
          before: object,
          selectedBefore,
          point: p,
          mode,
          after: object,
          frame: before.frame,
          alreadyExclusive: true,
        };
      if (selectedBefore.length > 1 || selectedBefore.some((obj) => obj.uid !== uid)) {
        const cancel = [
          [80, 80],
          [-80, 80],
          [80, -80],
          [-80, -80],
          [140, 0],
          [-140, 0],
        ]
          .map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy }))
          .find(
            (candidate) =>
              inTactical(candidate, before) &&
              before.objects.every((obj) => {
                const at = project(obj, before.view);
                return Math.hypot(candidate.x - at.x, candidate.y - at.y) >= 48;
              }),
          );
        if (!cancel) throw new Error('No empty tactical ground for real right-click deselection');
        await click(cancel.x, cancel.y, 'no-move', 'right');
        const cleared = await stateWait(
          'native selection cancelled',
          (next) => !local(next).some((obj) => obj.selected),
        );
        await record('right-click-ground-deselect', {
          point: cancel,
          selectedBefore,
          frame: cleared.state.frame,
          selectedAfter: [],
          verified: true,
          correction: 'Cancel on empty ground instead of invoking the target unit contextual action',
        });
        await shot('deselected');
      }
      await click(p.x, p.y, mode, 'left');
      const after = await stateWait('native single-unit click selection', (next) => {
        const selected = local(next).filter((obj) => obj.selected);
        return selected.length === 1 && selected[0].uid === uid ? selected[0] : null;
      });
      return { before: object, selectedBefore, point: p, mode, after: after.proof, frame: after.state.frame };
    };
    const idle = (object) =>
      object && /^(Guard|Stop)$/.test(object.mission) && !/^(Move|QMove)$/.test(object.queuedMission ?? '');
    const stableUnit = async (uid, timeout = 6000) => {
      let stable = null;
      return wait(
        'native unit stops moving',
        async () => {
          const next = await peek();
          const object = local(next).find((item) => item.uid === uid);
          if (!object) throw new Error(`Owned move-test object ${uid} no longer exists`);
          if (!idle(object)) {
            stable = null;
            return null;
          }
          if (!stable || Math.hypot(object.x - stable.object.x, object.y - stable.object.y) > 1) {
            stable = { at: performance.now(), frame: next.frame, object };
            return null;
          }
          return performance.now() - stable.at >= 200 && next.frame >= stable.frame + 4
            ? { before: stable, after: object, frame: next.frame }
            : null;
        },
        timeout,
      );
    };
    const worldAt = (point, view, z) => {
      const height = Math.trunc(z * zFactor + (z >= 728 ? 1 : 0) + 0.5);
      const horizontal = (point.x + view.x) / 30;
      const vertical = (point.y + view.y + height) / 15;
      return { x: (horizontal + vertical) * 128, y: (vertical - horizontal) * 128, z };
    };
    const cellAt = (point) => ({ x: Math.trunc(point.x / 256), y: Math.trunc(point.y / 256) });
    await shot('before');
    let state = await peek();
    const candidates = mobile(state).filter(
      (obj) => !/^(AMCV|MCV|SMCV|PCV)$/.test(obj.type) && inTactical(project(obj, state.view), state),
    );
    const target =
      candidates.find((obj) => obj.kind === 'vehicle' && idle(obj)) ?? candidates.find(idle) ?? candidates[0];
    if (!target) throw new Error('No visible owned ground unit for browser selection/move acceptance');
    const selection = await select(target.uid);
    await record('left-click-select', { ...selection, verified: true });
    await h.move(selection.point.x + 45, selection.point.y + 45);
    await delay(150);
    await shot('selected');
    await shot('cursor');
    if (api.selectionComparison) {
      await h.key('Backslash');
      await wait('selected original picture', async () => !(await h.diagnostic()).enabled);
      await delay(600);
      await shot('selected-original');
      await record('selected-original-state', { state: await peek(), diagnostic: await h.diagnostic() });
      await h.key('Backslash');
      await wait('selected keyed HD restored', async () => (await h.diagnostic()).shown);
      await delay(150);
      await shot('selected-restored');
    }

    const attempts = [];
    let moved = null;
    for (const button of ['right', 'left']) {
      await h.guard();
      await select(target.uid, 'quick');
      const beforeStop = local(await peek()).find((obj) => obj.uid === target.uid);
      await h.key('s');
      const stopped = await stableUnit(target.uid);
      state = await peek();
      const before = local(state).find((obj) => obj.uid === target.uid);
      const p = project(before, state.view);
      const destination = [
        { x: p.x + 72, y: p.y + 20 },
        { x: p.x - 72, y: p.y + 20 },
        { x: p.x + 30, y: p.y - 40 },
      ].find((d) => inTactical(d, state));
      if (!destination) throw new Error('No visible nearby ground destination');
      const requestedWorld = worldAt(destination, state.view, before.z);
      const requestedCell = cellAt(requestedWorld);
      await click(destination.x, destination.y, 'quick', button);
      const until = performance.now() + 3500;
      let last = null;
      let observedOrder = null;
      const samples = [];
      while (performance.now() < until) {
        await h.guard();
        state = await peek();
        last = local(state).find((obj) => obj.uid === target.uid);
        if (!last) throw new Error('Move-test unit was eliminated in the live battle');
        const changedDestination =
          last.destination?.kind === 'cell' && JSON.stringify(last.destination) !== JSON.stringify(before.destination);
        const moveMission = /^(Move|QMove)$/.test(last.mission) || /^(Move|QMove)$/.test(last.queuedMission ?? '');
        const matchesClick =
          last.destination?.kind === 'cell' &&
          Math.abs(last.destination.x - requestedCell.x) <= 1 &&
          Math.abs(last.destination.y - requestedCell.y) <= 1;
        if (!observedOrder && changedDestination && moveMission && matchesClick)
          observedOrder = { object: last, frame: state.frame };
        const changedPosition = Math.hypot(last.x - before.x, last.y - before.y) >= 32;
        const targetWorld = observedOrder
          ? {
              x: (observedOrder.object.destination.x + 0.5) * 256,
              y: (observedOrder.object.destination.y + 0.5) * 256,
            }
          : null;
        const beforeDistance = targetWorld ? Math.hypot(before.x - targetWorld.x, before.y - targetWorld.y) : null;
        const afterDistance = targetWorld ? Math.hypot(last.x - targetWorld.x, last.y - targetWorld.y) : null;
        const movedTowardOrder = observedOrder && changedPosition && afterDistance <= beforeDistance - 16;
        if (samples.length < 50) samples.push({ frame: state.frame, object: last });
        if (movedTowardOrder) {
          moved = {
            button,
            point: destination,
            requestedWorld,
            requestedCell,
            beforeStop,
            stopped,
            before,
            observedOrder,
            after: last,
            changedDestination: true,
            finalDestinationChanged: !!changedDestination,
            changedPosition,
            beforeDistance,
            afterDistance,
            movedTowardOrder: true,
            frame: state.frame,
          };
          break;
        }
        await delay(75);
      }
      attempts.push({
        button,
        point: destination,
        requestedCell,
        beforeStop,
        stopped,
        before,
        observedOrder,
        samples,
        last,
      });
      if (moved) break;
    }
    if (!moved) throw new Error(`Ground click did not change native destination/position: ${JSON.stringify(attempts)}`);
    await record('ground-move', { ...moved, attempts, verified: true });
    await shot('moved');

    state = await peek();
    const visible = mobile(state).filter((obj) => inTactical(project(obj, state.view), state));
    const beforeDrag = mobile(state).filter((obj) => obj.selected);
    const selectedUids = new Set(beforeDrag.map((obj) => obj.uid));
    if (visible.length < 2) throw new Error('Fewer than two owned visible ground units for browser drag selection');
    const points = visible.map((obj) => ({ uid: obj.uid, ...project(obj, state.view) }));
    const start = { x: Math.min(...points.map((p) => p.x)) - 18, y: Math.min(...points.map((p) => p.y)) - 24 };
    const finish = { x: Math.max(...points.map((p) => p.x)) + 18, y: Math.max(...points.map((p) => p.y)) + 18 };
    if (!inTactical(start, state, 1) || !inTactical(finish, state, 1))
      throw new Error('Observed group bounds leave tactical view');
    await h.move(start.x, start.y);
    await h.guard();
    await page.mouse.down({ button: 'left' });
    try {
      for (let i = 1; i <= 12; i++) {
        await h.guard();
        await h.move(start.x + ((finish.x - start.x) * i) / 12, start.y + ((finish.y - start.y) * i) / 12);
        await delay(25);
      }
      await shot('drag-band');
    } finally {
      await page.mouse.up({ button: 'left' });
    }
    const drag = await stateWait('native multi-unit drag selection', (next) => {
      const selected = mobile(next).filter((obj) => obj.selected);
      return selected.length >= 2 && selected.some((obj) => !selectedUids.has(obj.uid)) ? selected : null;
    });
    await record('drag-select', {
      start,
      finish,
      candidates: points,
      selectedBefore: beforeDrag,
      selected: drag.proof,
      frame: drag.state.frame,
      verified: true,
    });
    await shot('dragged');

    state = await peek();
    let yard = local(state).find((obj) => obj.kind === 'building' && /CNST$/.test(obj.type));
    if (!yard) {
      const mcv = mobile(state).find((obj) => /^(AMCV|MCV|SMCV|PCV)$/.test(obj.type));
      if (!mcv) throw new Error('No local MCV or construction yard for production acceptance');
      const deploymentAttempts = [];
      const commandSample = (next) =>
        next
          ? {
              frame: next.frame,
              view: next.view,
              localHouse: next.localHouse,
              objects: local(next).filter(
                (obj) => obj.uid === mcv.uid || (obj.kind === 'building' && /CNST$/.test(obj.type)),
              ),
              selectedUids: local(next)
                .filter((obj) => obj.selected)
                .map((obj) => obj.uid),
            }
          : null;
      const deploy = async (method, context) => {
        const before = await commandState();
        const object = local(before).find((obj) => obj.uid === mcv.uid);
        if (!object || !before.view) throw new Error('Local MCV disappeared before deployment input');
        const point = project(object, before.view);
        const proof = {
          method,
          context,
          point,
          before: commandSample(before),
          inputBefore: await inputState(),
          samples: [],
          yard: null,
        };
        if (method === 'keyboard-d') {
          await h.guard();
          await page.keyboard.down('d');
          try {
            await delay(100);
            proof.samples.push({
              at: performance.now(),
              phase: 'D-held',
              command: commandSample(await commandState()),
              input: await inputState(),
            });
            await delay(100);
          } finally {
            await page.keyboard.up('d');
          }
          await delay(100);
        } else {
          // Hover and double-click are the original game's ordinary alternative
          // deployment input. Compute the pixel again from the live MCV/view.
          await h.move(point.x, point.y);
          await delay(150);
          proof.inputAfterHover = await inputState();
          const pixel = await pointToBrowser(point);
          await h.guard();
          await page.mouse.dblclick(pixel.x, pixel.y, { button: 'left', delay: 80 });
        }
        proof.inputAfter = await inputState();
        const until = performance.now() + 4500;
        while (performance.now() < until) {
          await h.guard();
          const next = await commandState();
          proof.samples.push({ at: performance.now(), command: commandSample(next), input: await inputState() });
          const building = next ? local(next).find((obj) => obj.kind === 'building' && /CNST$/.test(obj.type)) : null;
          if (building) {
            proof.yard = building;
            proof.frame = next.frame;
            break;
          }
          await delay(100);
        }
        proof.inputFinal = await inputState();
        proof.after = commandSample(await commandState());
        deploymentAttempts.push(proof);
        await record('mcv-deploy-attempt', { ...proof, verified: !!proof.yard });
        await shot(`mcv-${method}-${deploymentAttempts.length}`);
        return proof;
      };
      const pointToBrowser = async (p) => {
        const value = await h.point(Math.round(p.x), Math.round(p.y));
        return Array.isArray(value) ? { x: value[0], y: value[1] } : value;
      };
      // Spawn locations ordinarily allow deployment. Try the original game
      // controls there before moving onto an observed but possibly sloped tile.
      const initialSelection = await select(mcv.uid, 'quick');
      const initial = await deploy('keyboard-d', { phase: 'initial-position', selected: initialSelection });
      yard = initial.yard;
      if (!yard) yard = (await deploy('hover-double-click', { phase: 'initial-position' })).yard;
      // Keep the foundation clear of the starting army. Nearby candidates are
      // observed visible ground, never revealed or made buildable by this script.
      const offsets = [
        [0, 7],
        [-7, 0],
        [7, 0],
        [0, -7],
        [5, 5],
        [-5, -5],
      ];
      for (const [dx, dy] of offsets) {
        await h.guard();
        if (yard) break;
        state = await peek();
        const currentMcv = local(state).find((obj) => obj.uid === mcv.uid);
        if (!currentMcv) throw new Error('Local MCV was eliminated before deployment');
        const world = { x: mcv.x + dx * 256, y: mcv.y + dy * 256, z: currentMcv.z };
        const destination = project(world, state.view);
        const cell = cellAt(world);
        if (!inTactical(destination, state, 55)) {
          deploymentAttempts.push({ world, point: destination, skipped: 'outside tactical view' });
          continue;
        }
        const visible = await page.evaluate(
          ({ cell, z }) => {
            const shroud = window.__hdBridge?.diagnostics?.state?.shroud;
            if (!shroud) return false;
            const level = Math.trunc(z / 104);
            const shift = Math.trunc(level / 2) + Number(!!(level & 1));
            const cells = [{ x: cell.x - shift, y: cell.y - shift }];
            if (level & 1) cells.push({ x: cell.x - shift + 1, y: cell.y - shift + 1 });
            return cells.some(({ x, y }) => {
              x -= shroud.originX;
              y -= shroud.originY;
              return (
                x >= 0 && y >= 0 && x < shroud.width && y < shroud.height && shroud.cells[y * shroud.width + x] === 2
              );
            });
          },
          { cell, z: world.z },
        );
        const nearby = state.objects.filter(
          (obj) => obj.uid !== mcv.uid && obj.health > 0 && Math.hypot(obj.x - world.x, obj.y - world.y) < 640,
        );
        if (!visible || nearby.length) {
          deploymentAttempts.push({
            world,
            point: destination,
            visible,
            nearby,
            skipped: 'not observed clear visible ground',
          });
          continue;
        }
        const selected = await select(mcv.uid, 'quick', false);
        const before = local(await peek()).find((obj) => obj.uid === mcv.uid);
        await click(destination.x, destination.y, 'quick', 'left');
        let arrival = null;
        try {
          const order = await stateWait('native MCV move to clear ground', (next) => {
            const object = local(next).find((obj) => obj.uid === mcv.uid);
            return object?.destination?.kind === 'cell' &&
              Math.abs(object.destination.x - cell.x) <= 1 &&
              Math.abs(object.destination.y - cell.y) <= 1 &&
              (/^(Move|QMove)$/.test(object.mission) || /^(Move|QMove)$/.test(object.queuedMission ?? ''))
              ? object
              : null;
          });
          arrival = await stableUnit(mcv.uid, 15000);
          const travelled = Math.hypot(arrival.after.x - before.x, arrival.after.y - before.y);
          const remaining = Math.hypot(arrival.after.x - world.x, arrival.after.y - world.y);
          if (travelled < 32 || remaining > 400) throw new Error('MCV did not reach the requested clear ground');
          const deployed = await deploy('keyboard-d', {
            phase: 'clear-ground',
            world,
            cell,
            point: destination,
            arrival,
          });
          yard = deployed.yard;
          if (!yard) throw new Error('Native deployment input produced no actual construction yard');
          deploymentAttempts.push({
            world,
            point: destination,
            cell,
            visible,
            selected,
            before,
            order: order.proof,
            arrival,
            travelled,
            remaining,
            yard,
            frame: deployed.frame,
          });
          break;
        } catch (error) {
          deploymentAttempts.push({
            world,
            point: destination,
            cell,
            visible,
            selected,
            before,
            arrival,
            error: String(error),
            after: await commandState(),
          });
          await shot(`deploy-rejected-${deploymentAttempts.length}`);
          state = await peek();
          yard = local(state).find((obj) => obj.kind === 'building' && /CNST$/.test(obj.type));
          if (yard) break;
        }
      }
      if (!yard) throw new Error(`No clear-ground MCV deployment succeeded: ${JSON.stringify(deploymentAttempts)}`);
      await record('deploy-mcv-for-production', { mcv, yard, attempts: deploymentAttempts, verified: true });
      await shot('yard');
    }
    const builtYard = await stateWait('construction yard finished deploying', (next) =>
      local(next).find((obj) => obj.uid === yard.uid && obj.mission !== 'Construction'),
    );
    state = builtYard.state;
    yard = builtYard.proof;
    const yardPoint = project(yard, state.view);
    // Deployment already selects the yard; clicking its unfinished base can
    // deselect it before the original building hit test becomes available.
    if (!yard.selected) await click(yardPoint.x, yardPoint.y, 'quick', 'left');
    const selectedBuilding = await stateWait('native selected building', (next) =>
      local(next).find((obj) => obj.uid === yard.uid && obj.selected),
    );
    await h.move(yardPoint.x + 170, yardPoint.y + 100);
    await delay(150);
    await shot('selected-building');
    await record('building-selection-feedback', selectedBuilding);
    if (api.selectionComparison) {
      await h.key('Backslash');
      await wait('selected building original picture', async () => !(await h.diagnostic()).enabled);
      await delay(600);
      await shot('selected-building-original');
      await h.key('Backslash');
      await wait('selected building keyed HD restored', async () => (await h.diagnostic()).shown);
    }
    state = await peek();
    const tab = state.sidebar?.layout.tabs[0];
    if (!tab) throw new Error('Native building sidebar tab is unavailable');
    await click(tab.x + tab.width / 2, tab.y + tab.height / 2, 'no-move', 'left');
    const opened = await stateWait(
      'native building tab',
      (next) => next.sidebar?.activeTab === 0 && next.sidebar.cameos.length,
    );
    const cameo =
      opened.state.sidebar.cameos.find((item) => /^(GAPOWR|NAPOWR|YAPOWR)$/.test(item.id)) ??
      opened.state.sidebar.cameos.find((item) => item.kind === 'building' && !item.darkened);
    if (!cameo) throw new Error('No actual visible buildable building cameo');
    const beforeFactory = await factory(h, cameo);
    if (beforeFactory.pointer) throw new Error('Observed production cameo must initially be idle');
    const size = opened.state.sidebar.layout.cameo;
    const cameoPoint = { x: cameo.x + size.width / 2, y: cameo.y + size.height / 2 };
    await click(cameoPoint.x, cameoPoint.y, 'quick', 'left');
    const samples = [];
    const producing = await wait(
      'native factory production',
      async () => {
        const current = await factory(h, cameo);
        if (samples.length < 60) samples.push({ at: performance.now(), ...current });
        return current.pointer &&
          current.object &&
          current.type === cameo.id &&
          (current.running || current.progress > 0)
          ? current
          : null;
      },
      12000,
    );
    await record('cameo-production', {
      id: cameo.id,
      point: cameoPoint,
      before: beforeFactory,
      after: producing,
      samples,
      verified: true,
    });
    await shot('production');
    const finished = await wait(
      'finished native building',
      async () => {
        const current = await factory(h, cameo);
        const next = await commandState();
        const actualCameo = next?.sidebar?.cameos.find((item) => item.id === cameo.id);
        return current.type === cameo.id && current.object && current.progress === 54 && actualCameo?.ready
          ? { factory: current, cameo: actualCameo, frame: next.frame }
          : null;
      },
      90000,
    );
    await record('finished-building', { id: cameo.id, ...finished, verified: true });
    await shot('ready');

    state = await peek();
    const oldBuildings = new Set(
      local(state)
        .filter((obj) => obj.kind === 'building')
        .map((obj) => obj.uid),
    );
    const placementAttempts = [];
    let placed = null;
    // Candidate pixels come from the observed construction yard, with a small
    // surrounding ring inside its ordinary building adjacency area. Invalid
    // foundations remain genuine rejected game clicks and are retained.
    const offsets = [
      [110, 45],
      [-110, 45],
      [90, -55],
      [-90, -55],
      [0, 95],
      [0, -85],
      [140, 0],
      [-140, 0],
      [70, 80],
      [-70, 80],
      [130, 65],
      [-130, 65],
      [70, -85],
      [-70, -85],
      [170, 30],
      [-170, 30],
      [0, 120],
      [0, -115],
    ];
    for (const [dx, dy] of offsets) {
      await h.guard();
      state = await peek();
      const currentYard = local(state).find((obj) => obj.uid === yard.uid);
      if (!currentYard) throw new Error('Construction yard was eliminated before placement');
      const yardPoint = project(currentYard, state.view);
      const destination = { x: yardPoint.x + dx, y: yardPoint.y + dy };
      if (!inTactical(destination, state, 8)) continue;
      const currentCameo = state.sidebar?.cameos.find((item) => item.id === cameo.id);
      if (!currentCameo?.ready) throw new Error('Finished building is no longer ready before observed placement');
      await click(currentCameo.x + size.width / 2, currentCameo.y + size.height / 2, 'no-move', 'left');
      await h.move(destination.x, destination.y);
      await delay(150);
      if (!placementAttempts.length) await shot('placement-preview');
      await click(destination.x, destination.y, 'quick', 'left');
      const until = performance.now() + 1400;
      let observed = null;
      while (performance.now() < until) {
        await h.guard();
        const next = await commandState();
        if (next?.view) {
          observed = local(next).find(
            (obj) => obj.kind === 'building' && obj.type === cameo.id && !oldBuildings.has(obj.uid),
          );
          if (observed) {
            placed = { point: destination, building: observed, frame: next.frame };
            break;
          }
        }
        await delay(75);
      }
      placementAttempts.push({ point: destination, building: observed });
      if (placed) break;
    }
    if (!placed)
      throw new Error(`No observed foundation accepted the finished building: ${JSON.stringify(placementAttempts)}`);
    await record('place-finished-building', {
      id: cameo.id,
      beforeUids: [...oldBuildings],
      ...placed,
      attempts: placementAttempts,
      verified: true,
    });
    await shot('placed');

    state = await peek();
    await h.move(state.sidebar.frame.width / 2, state.sidebar.frame.height / 2);
    const scrollAttempts = [];
    let scroll = null;
    for (const value of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
      await h.guard();
      const before = await peek();
      await h.key(value, 500);
      const after = await peek();
      scrollAttempts.push({ key: value, before: before.view, after: after.view, frame: after.frame });
      if (after.view.x !== before.view.x || after.view.y !== before.view.y) {
        scroll = scrollAttempts.at(-1);
        break;
      }
    }
    if (!scroll) throw new Error('Real browser arrow input did not move the native view');
    await record('arrow-scroll', { ...scroll, attempts: scrollAttempts, verified: true });
    await shot('scrolled');

    await h.key('Escape');
    const menu = await wait('native options menu', async () => {
      const next = await inputState();
      return next.modal && control(next, /resume|return.*game|continue/i) ? next : null;
    });
    const resume = control(menu, /resume|return.*game|continue/i);
    await record('escape-options', { modal: menu.modal, resume, lastKey: menu.lastKeyVirtualKey, verified: true });
    await shot('options');
    await h.clickControl(resume);
    const closed = await wait('native Resume closes options', async () => {
      const next = await inputState();
      return !next.modal ? next : null;
    });
    const beforeResume = await peek();
    const resumed = await stateWait('native logic resumes', (next) =>
      next.frame > beforeResume.frame + 5 ? next.frame : null,
    );
    await record('resume-close', {
      modal: closed.modal,
      beforeFrame: beforeResume.frame,
      afterFrame: resumed.proof,
      verified: true,
    });
    await shot('resumed');

    const hdBefore = await h.diagnostic();
    if (hdBefore.enabled !== true || hdBefore.shown !== true)
      throw new Error('HD picture must be shown before Backslash acceptance');
    await h.guard();
    await page.keyboard.press('Backslash');
    const original = await wait('Backslash exposes original picture', async () => {
      const next = await h.diagnostic();
      return next.enabled === false && next.shown === false ? next : null;
    });
    // The HD keyhole trail remains for about 500 ms after disabling the bridge.
    await delay(650);
    await shot('original-toggle');
    await h.guard();
    await page.keyboard.press('Backslash');
    const hdAfter = await wait(
      'Backslash restores HD picture',
      async () => {
        const next = await h.diagnostic();
        return next.enabled === true && next.shown === true ? next : null;
      },
      15000,
    );
    await record('backslash-original-hd', { before: hdBefore, original, after: hdAfter, verified: true });
    await shot('hd-toggle');
    await h.guard();
    h.report.met = true;
  } catch (error) {
    h.report.error = String(error.stack ?? error);
    h.report.inputAtFailure = await inputState().catch(() => null);
    h.report.commandAtFailure = await h.commandState().catch(() => null);
    await shot('failure').catch(() => undefined);
  } finally {
    await page.mouse.up({ button: 'left' }).catch(() => undefined);
    await page.mouse.up({ button: 'right' }).catch(() => undefined);
    for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Escape', 'd'])
      await page.keyboard.up(key).catch(() => undefined);
  }
  return h.finish();
}

/** End through the original defeat/score route or Abort Mission's direct setup route, then return to the menu. */
export async function runBrowserEnd(api) {
  const h = browserContext(api);
  try {
    const scoreTitle = /(?:skirmish|multiplayer)?score|statistic|results?|成绩|統計|统计|战绩|戰績|计分|計分/i;
    const scoreLabels = (state) => state.controls?.filter((item) => usable(item) && scoreTitle.test(item.text)) ?? [];
    const continueControl = (state) => control(state, /^(?:GUI:)?Continue$|继续|繼續|返回主菜单|return.*menu/i);
    const mainControl = (state) => control(state, 1667);
    const setupControl = (state) => control(state, 1559);
    const optionsControl = (state) => control(state, /resume|save.?game|load.?game|abort.*mission/i);
    let originalHouse = null;
    const localOutcome = async () => {
      // Render houses contain only colour/index. These pinned read-only fields
      // are the original HouseClass::ArrayIndex / Defeated from stateReader.ts.
      const state = await h.commandState();
      if (!originalHouse) {
        const pointer = await h.u32(0xa83d4c);
        if (pointer < 0x10000 || pointer % 4 || pointer > 0xfffffe00)
          return { frame: state?.frame ?? null, localHouse: state?.localHouse ?? null, defeated: null };
        const index = (await h.memory(pointer + 0x30, 4)).readInt32LE();
        if (index < 0 || index >= 32 || (state?.localHouse >= 0 && index !== state.localHouse))
          throw new Error('Original local HouseClass index does not match command state');
        originalHouse = { pointer, index };
      }
      let index;
      let flag;
      try {
        index = (await h.memory(originalHouse.pointer + 0x30, 4)).readInt32LE();
        flag = (await h.memory(originalHouse.pointer + 0x1f5, 1))[0];
      } catch (error) {
        return {
          frame: state?.frame ?? null,
          localHouse: originalHouse.index,
          defeated: null,
          reason: 'original house no longer readable',
          readError: String(error.message || error),
        };
      }
      if (index !== originalHouse.index)
        return {
          frame: state?.frame ?? null,
          localHouse: originalHouse.index,
          defeated: null,
          reason: 'house retired',
        };
      return {
        frame: state?.frame ?? null,
        localHouse: originalHouse.index,
        housePointer: originalHouse.pointer,
        defeatedFlag: flag,
        defeated: flag !== 0,
        originalBuildingCount: (await h.memory(originalHouse.pointer + 0x2f0, 4)).readInt32LE(),
        remainingBaseUnits: state?.objects
          .filter(
            (object) =>
              object.owner === originalHouse.index && object.health > 0 && /^(AMCV|SMCV|PCV)$/.test(object.type),
          )
          .map((object) => ({ uid: object.uid, type: object.type })),
        remainingOwned: state?.objects
          .filter((object) => object.owner === originalHouse.index && object.health > 0)
          .map((object) => ({
            uid: object.uid,
            type: object.type,
            kind: object.kind,
            health: object.health,
            mission: object.mission,
            queuedMission: object.queuedMission,
            selected: object.selected,
          })),
      };
    };
    const eliminateHuman = async () => {
      const startedAt = performance.now();
      const deadline = startedAt + 270000;
      const saleDeadline = startedAt + 90000;
      const sales = [];
      const shortGame = (await h.memory(0xa8b262, 1))[0];
      if (shortGame !== 0 && shortGame !== 1) throw new Error(`Invalid original ShortGame byte ${shortGame}`);
      await h.record('natural-elimination-policy', {
        originalShortGameAddress: 0xa8b262,
        originalShortGameByte: shortGame,
        shortGame: shortGame === 1,
        saleLimit: 32,
        saleDeadlineMs: 90000,
        naturalEnemyWaitMs: shortGame === 0 ? 180000 : 15000,
        totalDeadlineMs: 270000,
        input: 'real Sell inputs; ordinary P and S for current-view combat units when ShortGame is off',
      });
      const zFactor = (await h.memory(0xb0cd48, 8)).readDoubleLE();
      if (!Number.isFinite(zFactor) || zFactor <= 0 || zFactor > 4) throw new Error('Invalid native height projection');
      const project = (object, view) => ({
        x: Math.trunc((30 * (object.x - object.y)) / 256) - view.x,
        y:
          Math.trunc((15 * (object.x + object.y)) / 256) -
          Math.trunc(object.z * zFactor + (object.z >= 728 ? 1 : 0) + 0.5) -
          view.y,
      });
      const ownedBuildings = (state) => local(state).filter((object) => object.kind === 'building');
      const within = (point, state) => {
        const frame = state.sidebar?.frame;
        const side = state.sidebar?.layout.sidebar;
        if (!frame || !side) return false;
        const left = side.x === 0 ? side.width : 0;
        const right = side.x > 0 ? side.x : frame.width;
        const bottom = state.sidebar.layout.commandBar?.y ?? frame.height;
        return point.x >= left + 48 && point.x < right - 48 && point.y >= 48 && point.y < bottom - 48;
      };
      const checkDeadline = () => {
        if (performance.now() >= saleDeadline) throw new Error('Natural human elimination sales exceeded 90 seconds');
      };
      const waitAfterBases = async () => {
        let outcome = await localOutcome();
        if (outcome.defeated === true) {
          await h.record('human-naturally-defeated', { outcome, sales });
          return outcome;
        }
        if (outcome.originalBuildingCount !== 0)
          throw new Error(`Original own building count remains ${outcome.originalBuildingCount} after visible sales`);
        if (!Array.isArray(outcome.remainingBaseUnits) || outcome.remainingBaseUnits.length !== 0)
          throw new Error('A living original BaseUnit remains after building sales');
        if (
          !Array.isArray(outcome.remainingOwned) ||
          outcome.remainingOwned.some((object) => !Number.isFinite(object.health))
        )
          throw new Error('Remaining own object count or health is not readable before natural elimination');
        const beforePicture = await h.shot('natural-elimination-wait-before');
        if (shortGame === 0) {
          // Original keyboardmd.ini binds CombatantSelect=P and StopObject=S.
          // P addresses only ordinary current-view combatants; no hidden enemy
          // target, clock, guest state or defeat condition is changed here.
          await h.key('p', 120);
          const afterSelect = { input: await h.inputState(), outcome: await localOutcome() };
          await h.record('natural-elimination-visible-combat-select', {
            key: 'P',
            heldMs: 120,
            before: outcome,
            after: afterSelect,
            verifiedInput: afterSelect.input.lastKeyVirtualKey === 80,
          });
          if (afterSelect.input.lastKeyVirtualKey !== 80) throw new Error('P was not observed as native VK_P');
          if (afterSelect.outcome.defeated === true) {
            await h.record('human-naturally-defeated', {
              outcome: afterSelect.outcome,
              sales,
              beforePicture,
              afterPicture: await h.shot('natural-elimination-wait-after'),
            });
            return afterSelect.outcome;
          }
          await h.key('s', 120);
          const afterStop = { input: await h.inputState(), outcome: await localOutcome() };
          await h.record('natural-elimination-visible-combat-stop', {
            key: 'S',
            heldMs: 120,
            after: afterStop,
            verifiedInput: afterStop.input.lastKeyVirtualKey === 83,
          });
          if (afterStop.input.lastKeyVirtualKey !== 83) throw new Error('S was not observed as native VK_S');
        }
        const until = Math.min(deadline, performance.now() + (shortGame === 0 ? 180000 : 15000));
        const observations = [];
        while (performance.now() < until) {
          await h.guard();
          outcome = await localOutcome();
          const observation = {
            at: performance.now(),
            ...outcome,
            remainingOwnedCount: outcome.remainingOwned?.length ?? null,
          };
          observations.push(observation);
          await h.record('natural-elimination-wait-observation', observation);
          if (outcome.defeated === true) {
            const afterPicture = await h.shot('natural-elimination-wait-after');
            await h.record('human-naturally-defeated', { outcome, sales, observations, beforePicture, afterPicture });
            return outcome;
          }
          if (outcome.originalBuildingCount !== 0 || outcome.remainingBaseUnits?.length !== 0)
            throw new Error('A native building or original BaseUnit reappeared during natural elimination wait');
          if (
            !Array.isArray(outcome.remainingOwned) ||
            outcome.remainingOwned.some((object) => !Number.isFinite(object.health))
          )
            throw new Error('Remaining own object count or health became unreadable during natural elimination wait');
          await delay(Math.min(1000, Math.max(1, until - performance.now())));
        }
        const afterPicture = await h.shot('natural-elimination-wait-timeout');
        await h.record('natural-elimination-wait-timeout', {
          outcome,
          sales,
          observations,
          beforePicture,
          afterPicture,
        });
        throw new Error(
          `Original human defeat did not occur within ${shortGame === 0 ? 180 : 15} seconds after base sales`,
        );
      };
      await h.key('h', 80);
      for (let sale = 0; sale < 32; sale++) {
        await h.guard();
        checkDeadline();
        const outcome = await localOutcome();
        if (outcome.defeated === true) {
          await h.record('human-naturally-defeated', { outcome, sales });
          return outcome;
        }
        let state = await h.peek();
        const buildings = ownedBuildings(state).sort(
          (a, b) => Number(/CNST$/.test(a.type)) - Number(/CNST$/.test(b.type)),
        );
        if (!buildings.length) {
          return waitAfterBases();
        }
        const target = buildings[0];
        let point = null;
        for (let camera = 0; camera < 24; camera++) {
          await h.guard();
          checkDeadline();
          state = await h.peek();
          const object = ownedBuildings(state).find((item) => item.uid === target.uid);
          if (!object) break;
          point = project(object, state.view);
          if (within(point, state)) break;
          const side = state.sidebar?.layout.sidebar;
          const frame = state.sidebar?.frame;
          if (!side || !frame) throw new Error('Native tactical bounds unavailable during sale');
          const left = side.x === 0 ? side.width : 0;
          const right = side.x > 0 ? side.x : frame.width;
          const bottom = state.sidebar.layout.commandBar?.y ?? frame.height;
          const dx = point.x - (left + right) / 2;
          const dy = point.y - bottom / 2;
          const horizontal = Math.abs(dx) >= Math.abs(dy);
          const delta = horizontal ? dx : dy;
          const key = horizontal ? (delta > 0 ? 'ArrowRight' : 'ArrowLeft') : delta > 0 ? 'ArrowDown' : 'ArrowUp';
          const hold = Math.min(350, Math.max(80, Math.abs(delta) * 0.5));
          await h.move((left + right) / 2, bottom / 2);
          await h.key(key, hold);
        }
        state = await h.peek();
        const building = ownedBuildings(state).find((item) => item.uid === target.uid);
        if (!building) {
          await h.record('sale-target-removed-before-click', { target, frame: state.frame });
          continue;
        }
        point = project(building, state.view);
        if (!within(point, state)) throw new Error(`Owned building ${building.uid} did not enter tactical view`);
        const readSell = async () => {
          const current = await h.commandState();
          const directByte = (await h.memory(sidebar + 0x11b1, 1))[0];
          if (directByte !== 0 && directByte !== 1) throw new Error(`Invalid native Sell mode byte ${directByte}`);
          const coreMode = current?.sidebar?.modes.sell ?? null;
          return {
            frame: current?.frame ?? null,
            coreMode,
            directByte,
            armed: coreMode === true || directByte === 1,
            sourcesDisagree: coreMode !== null && coreMode !== (directByte === 1),
            input: await h.inputState(),
          };
        };
        const arming = {
          buildingUid: building.uid,
          actualButton: state.sidebar.layout.buttons.sell,
          originalModeAddress: sidebar + 0x11b1,
          before: await readSell(),
          attempts: [],
        };
        const observeArming = async (timeout) => {
          const until = performance.now() + timeout;
          const samples = [];
          let latest = null;
          do {
            await h.guard();
            checkDeadline();
            latest = await readSell();
            if (samples.length < 32)
              samples.push({
                frame: latest.frame,
                coreMode: latest.coreMode,
                directByte: latest.directByte,
                armed: latest.armed,
                sourcesDisagree: latest.sourcesDisagree,
                lastKeyVirtualKey: latest.input.lastKeyVirtualKey,
              });
            if (latest.armed) break;
            await delay(75);
          } while (performance.now() < until);
          return { latest, samples };
        };
        let sell = arming.before;
        if (!sell.armed && arming.actualButton) {
          const button = arming.actualButton;
          const buttonPoint = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
          await h.click(buttonPoint.x, buttonPoint.y, 'quick', 'left', 80);
          const observation = await observeArming(800);
          arming.attempts.push({ input: 'real browser Sell button', point: buttonPoint, heldMs: 80, ...observation });
          sell = observation.latest;
          await h.record('native-sell-button-attempt', { ...arming, after: sell });
        }
        if (!sell.armed) {
          await h.key('l', 120);
          const observation = await observeArming(3000);
          arming.attempts.push({ input: 'real browser L', heldMs: 120, ...observation });
          sell = observation.latest;
          await h.record('native-sell-key-attempt', { ...arming, after: sell });
          if (sell.input.lastKeyVirtualKey !== 76)
            throw new Error(`Sell key input was not observed as VK_L: ${sell.input.lastKeyVirtualKey}`);
        }
        // These are separate read-only observations of the original mode, so
        // retain any delivery-time disagreement instead of fabricating a flag.
        sell = await readSell();
        await h.record('native-sell-mode-before-building-click', { ...arming, after: sell, verified: sell.armed });
        if (!sell.armed) throw new Error('Neither the core sidebar nor the original Sell byte became armed');
        const beforePicture = await h.shot(`sale-${building.uid}-before`);
        await h.click(point.x, point.y, 'quick', 'left', 80);
        const started = await h.wait('native building sale started', async () => {
          const next = await h.commandState();
          const object = next?.objects.find((item) => item.uid === building.uid);
          return next && (!object || object.mission === 'Selling' || object.queuedMission === 'Selling')
            ? { frame: next.frame, object: object ?? null }
            : null;
        });
        let missing = null;
        const gone = await h.wait(
          'native sold building removed',
          async () => {
            const next = await h.commandState();
            if (!next || next.objects.some((item) => item.uid === building.uid)) {
              missing = null;
              return null;
            }
            if (!missing) missing = { frame: next.frame, at: performance.now() };
            if (performance.now() - missing.at < 100) return null;
            const outcome = await localOutcome();
            return next.frame >= missing.frame + 3 || outcome.defeated === true
              ? { frame: next.frame, buildings: ownedBuildings(next), credits: next.sidebar?.credits ?? null, outcome }
              : null;
          },
          Math.min(15000, Math.max(1, saleDeadline - performance.now())),
        );
        const proof = {
          building,
          point,
          beforeFrame: state.frame,
          creditsBefore: state.sidebar.credits,
          started,
          gone,
          beforePicture,
        };
        sales.push(proof);
        await h.record('native-building-sold', proof);
        await h.shot(`sale-${building.uid}-after`);
        // A normal defeat can retire the battlefield snapshot immediately.
        // Do not require another live view after the original house has lost.
        if (gone.outcome.defeated === true) {
          await h.record('human-naturally-defeated', { outcome: gone.outcome, sales });
          return gone.outcome;
        }
      }
      const remaining = await h.commandState();
      if (remaining?.view && ownedBuildings(remaining).length === 0) return waitAfterBases();
      throw new Error('Natural elimination exceeded the bounded 32-building sale limit');
    };
    let continuedEnding = false;
    let observedOutcome = null;
    let aborted = false;
    const visualCandidates = [];
    const continueEnding = async (state, outcome) => {
      const labels = readBrowserEndingLabels(state);
      const kind = labels.labelledOutcome ?? 'unidentified-ending';
      observedOutcome = labels.labelledOutcome;
      const next = continueControl(state) ?? control(state, /^GUI:OK$|^OK$|确定|確定/i);
      const screenshot = await h.shot(kind + '-overlay-before-continue');
      // A native owner-drawn score may expose only Continue. Retain this image
      // before advancing an unlabelled overlay so later visual review can tell
      // whether it was the defeat prompt or the actual score table.
      visualCandidates.push({ screenshot, controls: state.controls, outcome, phase: 'before-ending-continue' });
      await h.record(kind + '-overlay', {
        controls: state.controls,
        labels,
        outcome,
        continueControl: next,
        screenshot,
        verified: false,
        labelledOutcomeObserved: state.modal && labels.labelledOutcome !== null,
        visualReviewRequired: true,
        establishesCorrectEndingScreen: false,
      });
      if (next) await h.clickControl(next, 'quick');
      else await h.key('Enter', 80);
      continuedEnding = true;
      await h.record(kind + '-overlay-continue', { input: next ? { click: next } : { key: 'Enter' }, sentOnce: true });
      await delay(1500);
    };
    let current = await h.inputState();
    let initialOutcome = await localOutcome();
    const initialScore = scoreLabels(current).length > 0 && continueControl(current);
    const alreadyEnded =
      current.modal === true &&
      !mainControl(current) &&
      !setupControl(current) &&
      !initialScore &&
      !optionsControl(current) &&
      (initialOutcome.defeated === true || readBrowserEndingLabels(current).labelledOutcome !== null);
    if (alreadyEnded) {
      await continueEnding(current, initialOutcome);
    } else if (api.eliminateHuman === true && !initialScore && !mainControl(current) && !setupControl(current)) {
      if (current.modal) {
        const resume = control(current, /resume.*mission/i);
        if (!resume) throw new Error('An unrelated native modal prevents safe natural elimination');
        await h.clickControl(resume, 'quick');
        await h.wait('native battle resumed before sales', async () => !(await h.inputState()).modal);
      }
      initialOutcome = await eliminateHuman();
      await delay(1500);
      current = await h.inputState();
      if (current.modal && !scoreLabels(current).length && !mainControl(current) && !setupControl(current))
        await continueEnding(current, initialOutcome);
    } else if (
      !initialScore &&
      !mainControl(current) &&
      !setupControl(current) &&
      (!current.modal || optionsControl(current))
    ) {
      if (!current.modal) await h.key('Escape');
      const options = await h.wait('Abort Mission option', async () => {
        const next = await h.inputState();
        return next.modal && control(next, /abort|surrender|quit|exit.*game/i) ? next : null;
      });
      const abort = control(options, /abort|surrender|quit|exit.*game/i);
      const optionsPicture = await h.shot('abort-options');
      await h.record('abort-options', {
        modal: options.modal,
        abort,
        controls: options.controls,
        screenshot: optionsPicture,
        verified: true,
      });
      await h.clickControl(abort);
      const confirmation = await h.wait('Abort Mission confirmation', async () => {
        const next = await h.inputState();
        return next.modal && control(next, 1737) && control(next, /resume.*mission/i) ? next : null;
      });
      const confirm = control(confirmation, 1737);
      await h.record('abort-confirmation', { abort, confirm, controls: confirmation.controls, verified: true });
      await h.shot('abort-confirmation');
      await h.clickControl(confirm);
      aborted = true;
      await h.record('abort-confirmed', {
        controlId: confirm.id,
        input: 'trusted browser click',
        after: await h.inputState(),
      });
    }
    // Original YR includes GUI:SkirmishScore / GUI:MultiplayerScore and
    // GUI:Continue. NativeCore does not publish shell-page callbacks, so a
    // stale canvas dataset title never establishes native score acceptance.
    const scoreObservations = [];
    const scoreDeadline = performance.now() + 60000;
    let score = null;
    let scoreSkippedByAbort = false;
    while (performance.now() < scoreDeadline) {
      await h.guard();
      current = await h.inputState();
      const diagnostic = await h.diagnostic();
      const labels = scoreLabels(current);
      const next = continueControl(current);
      const mainMenu = mainControl(current);
      const setup = setupControl(current);
      const options = optionsControl(current);
      const outcome = await localOutcome();
      if (scoreObservations.length < 320)
        scoreObservations.push({
          at: performance.now(),
          controls: current.controls,
          diagnostic,
          labels,
          continueControl: next,
          outcome,
        });
      if (!mainMenu && !options && diagnostic.shown === false && labels.length > 0 && next) {
        // Controls become visible before their original entrance animation
        // accepts input. Keep this settled score image before any Continue.
        await delay(5000);
        current = await h.inputState();
        if (!scoreLabels(current).length || !continueControl(current)) continue;
        score = {
          controls: current.controls,
          diagnostic: await h.diagnostic(),
          labels: scoreLabels(current),
          continueControl: continueControl(current),
          outcome,
        };
        break;
      }
      if (mainMenu) break;
      if (setup) {
        scoreSkippedByAbort = aborted;
        await h.record('setup-before-score', {
          setup,
          controls: current.controls,
          screenshot: await h.shot('setup-before-score'),
          scoreSkippedByAbort,
          verifiedScore: false,
        });
        break;
      }
      if (
        !continuedEnding &&
        !options &&
        labels.length === 0 &&
        current.modal &&
        (outcome.defeated === true || readBrowserEndingLabels(current).labelledOutcome !== null)
      ) {
        await continueEnding(current, outcome);
        continue;
      }
      await delay(200);
    }
    // Retain a visible picture even when native diagnostics cannot identify it.
    // A later human screenshot review is separate from this script's verdict.
    await delay(650);
    const scorePicture = await h.shot(scoreSkippedByAbort ? 'abort-returned-setup' : 'score');
    visualCandidates.push({
      screenshot: scorePicture,
      controls: score?.controls ?? current.controls,
      diagnostic: score?.diagnostic ?? (await h.diagnostic()),
      phase: 'score-wait-complete',
    });
    let visualVerification = null;
    if (!scoreSkippedByAbort && !score && typeof api.scoreVisualVerifier === 'function') {
      // The root may supply actual screenshot-review evidence. A screenshot
      // path alone never turns a defeat prompt or main menu into a score pass.
      const evidence = await api.scoreVisualVerifier(visualCandidates);
      if (
        evidence?.verified === true &&
        typeof evidence.screenshot === 'string' &&
        visualCandidates.some((item) => item.screenshot === evidence.screenshot) &&
        typeof evidence.reason === 'string' &&
        evidence.reason.trim()
      )
        visualVerification = evidence;
    }
    await h.record('score-screen', {
      controls: score?.controls ?? current.controls,
      diagnostic: score?.diagnostic ?? (await h.diagnostic()),
      screenshot: scorePicture ?? null,
      scoreLabels: score?.labels ?? [],
      continueControl: score?.continueControl ?? null,
      nativeShellPageUsed: false,
      observations: scoreObservations,
      visualCandidates,
      visualVerification,
      scoreSkippedByAbort,
      verified: !scoreSkippedByAbort && (!!score || !!visualVerification),
      expectedAbortRoute: scoreSkippedByAbort,
      scoreRequired: !scoreSkippedByAbort,
      verification: scoreSkippedByAbort
        ? 'Expected original Abort Mission route: directly to skirmish setup; no score screen'
        : score
          ? 'native score labels and Continue plus screenshot'
          : visualVerification
            ? 'root screenshot review'
            : 'UNVERIFIED: screenshot review required',
      visualVerificationRequired: !scoreSkippedByAbort && !score && !visualVerification,
    });
    let returned = null;
    const actions = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      await h.guard();
      current = await h.inputState();
      if (mainControl(current)) {
        returned = current;
        break;
      }
      if (setupControl(current)) {
        const back = control(current, 1472);
        if (!back) throw new Error('Native skirmish setup has no enabled Back control');
        actions.push({ click: back, intermediary: 'SkirmishSetup' });
        await h.clickControl(back, 'quick');
        await delay(1500);
        continue;
      }
      const next = control(current, /continue|next|return.*menu|main.?menu|^GUI:OK$|继续|繼續|主菜单|主選單/i);
      if (next) {
        actions.push({ click: next });
        await h.clickControl(next, 'quick');
      } else {
        // Return is the ordinary native score-screen continue shortcut. A
        // screenshot records what it acts on when no diagnostic control exists.
        actions.push({ key: 'Enter' });
        await h.key('Enter', 80);
      }
      await delay(1500);
    }
    if (!returned) {
      current = await h.inputState();
      if (mainControl(current)) returned = current;
    }
    if (!returned) throw new Error(`Score continuation did not return to actual main menu: ${JSON.stringify(actions)}`);
    await delay(1500);
    returned = await h.inputState();
    if (!mainControl(returned)) throw new Error('Native main-menu control 1667 did not remain visible after return');
    const menuPicture = await h.shot('returned-menu');
    await h.record('return-main-menu', {
      singlePlayer: mainControl(returned),
      controls: returned.controls,
      screenshot: menuPicture,
      actions,
      verified: true,
    });
    h.report.scoreVisualVerificationRequired = !scoreSkippedByAbort && !score && !visualVerification;
    h.report.scoreSkippedByAbort = scoreSkippedByAbort;
    h.report.observedOutcome = aborted ? 'abort' : observedOutcome;
    h.report.endingVisualReviewRequired = true;
    if (!scoreSkippedByAbort && !score && !visualVerification)
      throw new Error('Returned to main menu, but visible score screen was not identified by native diagnostics');
    await h.guard();
    h.report.met = true;
  } catch (error) {
    h.report.error = String(error.stack ?? error);
    h.report.inputAtFailure = await h.inputState().catch(() => null);
    await h.shot('end-failure').catch(() => undefined);
  }
  return h.finish();
}
