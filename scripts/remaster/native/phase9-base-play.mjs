import { setTimeout as delay } from 'node:timers/promises';

// YR 1.001 observations already used by browser-battle-input.mjs. All writes
// belong to the ordinary browser input path, never these memory addresses.
const SIDEBAR = 0x87f7e8;
const STRIPS = SIDEBAR + 0x1544;
const STRIP_SIZE = 0xf94;
const own = (state) => state.objects.filter((object) => object.owner === state.localHouse && object.health > 0);
const powerTypes = /^(GAPOWR|NAPOWR|YAPOWR)$/;
const barracksTypes = /^(GAPILE|NAHAND|YABRCK)$/;
const refineryTypes = /^(GAREFN|NAREFN)$/;
const warFactoryTypes = /^(GAWEAP|NAWEAP|YAWEAP)$/;
const infantryTypes = /^(E1|E2|INIT)$/;
const combatVehicleTypes = /^(MTNK|HTNK|LTNK)$/;
const yardTypes = /^(GACNST|NACNST|YACNST)$/;
const mcvTypes = /^(AMCV|MCV|SMCV|PCV)$/;
const constructionComplete = (object) =>
  typeof object.mission === 'string' &&
  object.mission.length > 0 &&
  object.mission !== 'Construction' &&
  object.queuedMission !== 'Construction';

/** Ordinary deploy/build/train/move play, with genuine native object evidence. */
export async function runPhase9BasePlay(api) {
  const report = {
    startedAt: new Date().toISOString(),
    input: 'Trusted browser mouse/keyboard events; read-only command/sidebar/factory observations',
    steps: [],
    met: false,
  };
  const started = performance.now();
  const guard = async () => {
    await api.ownerIdle?.();
  };
  const record = async (name, proof) => {
    report.steps.push({ name, at: new Date().toISOString(), ...proof });
    await api.record?.(name, proof);
  };
  const shot = async (label) => {
    const path = await api.shot(`base-${label}`);
    report.steps.push({ name: 'screenshot', label, path });
    return path;
  };
  const memory = async (address, length) => Buffer.from(await api.readBytes(address, length));
  const u32 = async (address) => (await memory(address, 4)).readUInt32LE();
  const wait = async (label, observe, timeout = 10000) => {
    const until = performance.now() + timeout;
    while (performance.now() < until) {
      await guard();
      const value = await observe();
      if (value) return value;
      await delay(100);
    }
    throw new Error(`${label} did not produce its real native state in ${timeout} ms`);
  };
  const peek = () =>
    wait('live owned battle', async () => {
      const state = await api.commandState();
      return state?.view && state.localHouse >= 0 && state.sidebar ? state : null;
    });
  const stateWait = (label, predicate, timeout) =>
    wait(
      label,
      async () => {
        const state = await api.commandState();
        if (!state?.view) return null;
        const observed = predicate(state);
        return observed ? { state, observed } : null;
      },
      timeout,
    );
  const browserPoint = async (point) => {
    const result = await api.point(Math.round(point.x), Math.round(point.y));
    return Array.isArray(result) ? { x: result[0], y: result[1] } : result;
  };
  const move = async (point) => {
    await guard();
    const browser = await browserPoint(point);
    await api.page.mouse.move(browser.x, browser.y);
  };
  const click = async (point, button = 'left') => {
    await guard();
    // Keep the existing battle helper's click adapter contract.
    await api.click(Math.round(point.x), Math.round(point.y), 'quick', button);
    await delay(120);
  };
  const key = async (value, heldMs = 100) => {
    await guard();
    await api.page.keyboard.down(value);
    try {
      await delay(heldMs);
    } finally {
      await api.page.keyboard.up(value);
    }
    await delay(150);
  };
  let project;
  const tactical = (point, state, margin = 24) => {
    const frame = state.sidebar.frame;
    const side = state.sidebar.layout.sidebar;
    const left = side.x === 0 ? side.width : 0;
    const right = side.x > 0 ? side.x : frame.width;
    const bottom = state.sidebar.layout.commandBar?.y ?? frame.height;
    return point.x >= left + margin && point.x < right - margin && point.y >= margin && point.y < bottom - margin;
  };
  const select = async (uid) => {
    const before = await peek();
    const object = own(before).find((value) => value.uid === uid);
    if (!object) throw new Error(`Owned object ${uid} disappeared before ordinary selection`);
    const point = project(object, before.view);
    if (!tactical(point, before)) throw new Error(`Owned object ${uid} is outside the visible tactical area`);
    await click(point);
    return stateWait('real selected object', (state) =>
      own(state).find((value) => value.uid === uid && value.selected),
    );
  };
  const factory = async (cameo, tab) => {
    const entry = STRIPS + tab * STRIP_SIZE + 0x58 + cameo.index * 0x34;
    const pointer = await u32(entry + 0xc);
    if (!pointer) return { pointer: 0, progress: null, object: 0, running: false, type: null };
    if (pointer < 0x10000 || pointer % 4) throw new Error('Implausible observed factory pointer');
    const raw = await memory(pointer, 0x74);
    const object = raw.readUInt32LE(0x58);
    let type = null;
    if (object) {
      const typeOffset = cameo.kind === 'building' ? 0x520 : cameo.kind === 'vehicle' ? 0x6c4 : 0x6c0;
      const typePointer = await u32(object + typeOffset);
      if (typePointer >= 0x10000 && !(typePointer % 4))
        type = (await memory(typePointer + 0x24, 24)).toString('ascii').split('\0')[0];
    }
    return {
      pointer,
      progress: raw.readInt32LE(0x24),
      running: raw.readInt32LE(0x38) !== 0,
      object,
      hold: raw[0x70] !== 0,
      type,
    };
  };
  const openTab = async (index) => {
    const state = await peek();
    const tab = state.sidebar.layout.tabs[index];
    if (!tab) throw new Error(`Actual native sidebar tab ${index} is unavailable`);
    if (state.sidebar.activeTab !== index) await click({ x: tab.x + tab.width / 2, y: tab.y + tab.height / 2 });
    return (
      await stateWait(
        'real sidebar tab ' + index,
        (next) => next.sidebar?.activeTab === index && next.sidebar.cameos.length,
      )
    ).state;
  };
  const cameoPoint = (cameo, state) => ({
    x: cameo.x + state.sidebar.layout.cameo.width / 2,
    y: cameo.y + state.sidebar.layout.cameo.height / 2,
  });
  const build = async (label, types, anchors) => {
    let state = await openTab(0);
    const cameo = state.sidebar.cameos.find(
      (value) => value.kind === 'building' && types.test(value.id) && !value.darkened,
    );
    if (!cameo)
      throw new Error(
        `The actual sidebar has no enabled ${label} cameo: ${state.sidebar.cameos.map((value) => value.id).join(', ')}`,
      );
    const before = await factory(cameo, 0);
    if (!cameo.ready && !before.pointer) {
      await click(cameoPoint(cameo, state));
      const begun = await wait(
        'real ' + label + ' production begins',
        async () => {
          const current = await factory(cameo, 0);
          return current.pointer &&
            current.object &&
            current.type === cameo.id &&
            (current.running || current.progress > 0)
            ? current
            : null;
        },
        12000,
      );
      await record('base-' + label + '-production', { id: cameo.id, before, begun });
      await shot(label + '-production');
    } else if (before.type !== cameo.id && !cameo.ready) {
      throw new Error(`Another factory item prevents ordinary ${label} production`);
    }
    const ready = await wait(
      'real ready ' + label,
      async () => {
        const current = await factory(cameo, 0);
        const next = await peek();
        const currentCameo = next.sidebar.cameos.find((value) => value.id === cameo.id);
        return current.type === cameo.id && current.object && current.progress === 54 && currentCameo?.ready
          ? { factory: current, cameo: currentCameo, state: next }
          : null;
      },
      90000,
    );
    await record('base-' + label + '-ready', { id: cameo.id, factory: ready.factory, frame: ready.state.frame });
    await shot(label + '-ready');
    const previous = new Set(
      own(ready.state)
        .filter((value) => value.kind === 'building')
        .map((value) => value.uid),
    );
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
      [180, 75],
      [-180, 75],
      [180, -75],
      [-180, -75],
      [0, 130],
      [0, -130],
    ];
    const attempts = [];
    for (const anchorUid of anchors) {
      for (const [dx, dy] of offsets) {
        state = await peek();
        const anchor = own(state).find((value) => value.uid === anchorUid);
        if (!anchor) continue;
        const origin = project(anchor, state.view);
        const point = { x: origin.x + dx, y: origin.y + dy };
        if (!tactical(point, state, 10)) continue;
        const currentCameo = state.sidebar.cameos.find((value) => value.id === cameo.id && value.ready);
        if (!currentCameo) throw new Error(`Ready ${label} vanished before actual placement`);
        await click(cameoPoint(currentCameo, state));
        await move(point);
        await delay(200);
        const preview = await peek();
        const previewFile = await shot(`${label}-preview-${attempts.length + 1}`);
        // The original foundation preview is left intact. No terrain legality
        // is inferred from coordinates or made true by modifying cells.
        await click(point);
        let placed = null;
        try {
          placed = await stateWait(
            'new owned ' + label,
            (next) =>
              own(next).find(
                (value) => value.kind === 'building' && value.type === cameo.id && !previous.has(value.uid),
              ),
            1800,
          );
        } catch {
          // A rejected foundation is normal game input and remains evidence.
        }
        const attempt = {
          anchorUid,
          point,
          previewFrame: preview.frame,
          pointer: preview.sidebar.pointer,
          previewFile,
          placed: placed?.observed ?? null,
        };
        attempts.push(attempt);
        await record('base-' + label + '-placement-attempt', attempt);
        if (placed) {
          const completed = await stateWait(
            label + ' placed and construction complete',
            (next) => own(next).find((value) => value.uid === placed.observed.uid && constructionComplete(value)),
            15000,
          );
          await record('base-' + label + '-placed', {
            id: cameo.id,
            building: completed.observed,
            frame: completed.state.frame,
            attempts,
            verified: true,
          });
          await shot(label + '-placed');
          return completed.observed;
        }
        // Cancel the real rejected placement mode before rearming the cameo.
        await click(point, 'right');
      }
    }
    throw new Error(`The original game rejected every observed ${label} foundation: ${JSON.stringify(attempts)}`);
  };

  const trainAndMove = async (label, kind, types, tab, originUid) => {
    let state = await openTab(tab);
    const cameo = state.sidebar.cameos.find((value) => value.kind === kind && types.test(value.id) && !value.darkened);
    if (!cameo) throw new Error(`The actual ${kind} tab has no enabled basic combat ${kind} cameo`);
    const previousUnits = new Set(
      own(state)
        .filter((value) => value.kind === kind)
        .map((value) => value.uid),
    );
    for (let index = 0; index < 3; index++) {
      state = await peek();
      const current = state.sidebar.cameos.find((value) => value.id === cameo.id);
      if (!current) throw new Error(`The live ${kind} cameo disappeared while queuing units`);
      await click(cameoPoint(current, state));
      await record('base-' + label + '-train-click', { index: index + 1, id: cameo.id, frame: state.frame });
    }
    await shot(label + '-producing');
    const trained = await stateWait(
      'three newly trained owned ' + label,
      (next) => {
        const fresh = own(next).filter(
          (value) => value.kind === kind && value.type === cameo.id && !previousUnits.has(value.uid),
        );
        return fresh.length >= 3 ? fresh.slice(0, 3) : null;
      },
      90000,
    );
    await record('base-' + label + '-trained', {
      id: cameo.id,
      units: trained.observed,
      frame: trained.state.frame,
      verified: true,
    });
    await shot(label + '-trained');
    if (kind === 'vehicle') {
      // A freshly delivered tank can still be behind the factory's roof. Its
      // ground point then hits the building, not the tank. Use the original
      // combat-unit selection hotkey and still verify every newly trained UID.
      await key('p');
      await record('base-' + label + '-group-selection', { input: 'Ordinary P combat-unit selection' });
    } else {
      await select(trained.observed[0].uid);
      await guard();
      await api.page.keyboard.down('Shift');
      try {
        for (const unit of trained.observed.slice(1)) {
          state = await peek();
          const current = own(state).find((value) => value.uid === unit.uid);
          if (!current) throw new Error('A newly trained unit was eliminated before group selection');
          await click(project(current, state.view));
        }
      } finally {
        await api.page.keyboard.up('Shift');
      }
    }
    let retrySelectionAt = performance.now() + 750;
    const selected = await wait('all newly trained units selected', async () => {
      const next = await api.commandState();
      if (!next?.view) return null;
      const selectedUnits = own(next).filter(
        (value) => value.selected && trained.observed.some((unit) => unit.uid === value.uid),
      );
      if (selectedUnits.length === 3) return { state: next, observed: selectedUnits };
      // Newly created vehicles can still be leaving the factory when P first
      // runs. A later exit does not automatically join the earlier selection.
      if (kind === 'vehicle' && performance.now() >= retrySelectionAt) {
        await key('p');
        retrySelectionAt = performance.now() + 750;
      }
      return null;
    });
    // Stop the freshly spawned group through the original hotkey. Its native
    // walking-out/rally motion must finish before it becomes the Move baseline.
    const inputBeforeStop = await api.inputState();
    await key('s');
    const inputAfterStop = await api.inputState();
    const stopSamples = [];
    let lastStamp = null;
    let lastFrame = null;
    let matchingFrames = 0;
    const stopped = await stateWait(
      'trained group stopped with stable position and destination',
      (next) => {
        const units = trained.observed.map((before) => own(next).find((value) => value.uid === before.uid));
        if (units.some((value) => !value?.selected)) return null;
        const moving = units.some(
          (value) => /^(Move|QMove)$/.test(value.mission) || /^(Move|QMove)$/.test(value.queuedMission ?? ''),
        );
        const stamp = JSON.stringify(units.map(({ uid, x, y, z, destination }) => ({ uid, x, y, z, destination })));
        if (stopSamples.length < 100) stopSamples.push({ at: performance.now(), frame: next.frame, units, moving });
        if (!moving && stamp === lastStamp && next.frame !== lastFrame) matchingFrames++;
        else matchingFrames = 0;
        lastStamp = stamp;
        lastFrame = next.frame;
        return matchingFrames >= 3 ? units : null;
      },
      15000,
    );
    await record('base-' + label + '-stopped-before-move', {
      input: 'Ordinary trusted S hotkey',
      inputBefore: inputBeforeStop,
      inputAfter: inputAfterStop,
      units: stopped.observed,
      frame: stopped.state.frame,
      samples: stopSamples,
      verified: true,
    });
    await shot(label + '-stopped');
    state = stopped.state;
    const currentOrigin = own(state).find((value) => value.uid === originUid);
    if (!currentOrigin) throw new Error(`The owned ${label} production building disappeared`);
    const origin = project(currentOrigin, state.view);
    const destinations = [
      [190, 70],
      [-190, 70],
      [150, -100],
      [-150, -100],
      [0, 160],
      [0, -140],
    ].map(([dx, dy]) => ({ x: origin.x + dx, y: origin.y + dy }));
    const destination = destinations.find(
      (candidate) =>
        tactical(candidate, state, 40) &&
        state.objects.every(
          (value) =>
            value.health <= 0 ||
            Math.hypot(candidate.x - project(value, state.view).x, candidate.y - project(value, state.view).y) >= 45,
        ),
    );
    if (!destination) throw new Error('No visible unobstructed tactical destination for ordinary movement');
    await shot(label + '-selected');
    await click(destination);
    const selectedByUid = new Map(stopped.observed.map((value) => [value.uid, value]));
    const ordered = await stateWait(
      'ordinary group Move accepted by every trained unit',
      (next) => {
        const units = trained.observed.map((before) => own(next).find((value) => value.uid === before.uid));
        return units.every((value) => {
          const before = value && selectedByUid.get(value.uid);
          return (
            before &&
            value.destination?.kind === 'cell' &&
            (/^(Move|QMove)$/.test(value.mission) || /^(Move|QMove)$/.test(value.queuedMission ?? '')) &&
            (before.destination?.kind !== 'cell' ||
              before.destination.x !== value.destination.x ||
              before.destination.y !== value.destination.y)
          );
        })
          ? units
          : null;
      },
      8000,
    );
    await record('base-' + label + '-move-order', {
      destination,
      before: stopped.observed,
      ordered: ordered.observed,
      frame: ordered.state.frame,
      verified: true,
    });
    const moved = await stateWait(
      'all trained units actually change position after move order',
      (next) => {
        const units = trained.observed.map((before) => own(next).find((value) => value.uid === before.uid));
        return units.every((value) => {
          const before = value && selectedByUid.get(value.uid);
          return before && (value.x !== before.x || value.y !== before.y);
        })
          ? units
          : null;
      },
      15000,
    );
    await record('base-' + label + '-moved', {
      destination,
      before: stopped.observed,
      after: moved.observed,
      frame: moved.state.frame,
      verified: true,
    });
    await shot(label + '-moved');
    return { trained: trained.observed, moved: moved.observed, destination };
  };

  try {
    if ((await api.inputState()).modal) throw new Error('A genuine battle must be resumed before base play');
    const zFactor = (await memory(0xb0cd48, 8)).readDoubleLE();
    if (!Number.isFinite(zFactor) || zFactor <= 0 || zFactor > 4)
      throw new Error('Implausible native ground projection');
    project = (object, view) => ({
      x: Math.trunc((30 * (object.x - object.y)) / 256) - view.x,
      y:
        Math.trunc((15 * (object.x + object.y)) / 256) -
        Math.trunc(object.z * zFactor + (object.z >= 728 ? 1 : 0) + 0.5) -
        view.y,
    });
    let state = await peek();
    report.localHouse = state.localHouse;
    report.initialFrame = state.frame;
    report.initialObjects = own(state);
    await shot('initial');
    let yard = own(state).find((object) => object.kind === 'building' && yardTypes.test(object.type));
    if (!yard) {
      const mcv = own(state).find((object) => object.kind === 'vehicle' && mcvTypes.test(object.type));
      if (!mcv) throw new Error('The actual owned army has no MCV or construction yard');
      const selected = await select(mcv.uid);
      await key('d', 150);
      try {
        yard = (
          await stateWait(
            'MCV replaced by owned construction yard',
            (next) => own(next).find((object) => object.kind === 'building' && yardTypes.test(object.type)),
            6000,
          )
        ).observed;
      } catch {
        state = await peek();
        const current = own(state).find((object) => object.uid === mcv.uid);
        if (!current) throw new Error('MCV disappeared without an owned construction yard');
        const at = await browserPoint(project(current, state.view));
        await guard();
        await api.page.mouse.dblclick(at.x, at.y, { button: 'left', delay: 80 });
        yard = (
          await stateWait(
            'ordinary double-click MCV deployment',
            (next) => own(next).find((object) => object.kind === 'building' && yardTypes.test(object.type)),
            6000,
          )
        ).observed;
      }
      await record('base-mcv-deployed', { mcv, selected: selected.observed, yard, verified: true });
    } else {
      await record('base-yard-already-deployed', {
        yard,
        limitation: 'Deployment happened earlier in this genuine match, not by this helper',
      });
    }
    yard = (
      await stateWait(
        'construction yard deploy completed',
        (next) => own(next).find((object) => object.uid === yard.uid && constructionComplete(object)),
        15000,
      )
    ).observed;
    report.yard = yard;
    await shot('yard');
    const power = await build('power-plant', powerTypes, [yard.uid]);
    report.powerPlant = power;
    const barracks = await build('barracks', barracksTypes, [yard.uid, power.uid]);
    report.barracks = barracks;

    if (!api.buildOnly) {
      const infantry = await trainAndMove('infantry', 'infantry', infantryTypes, 2, barracks.uid);
      report.trainedUnits = infantry.trained;
      report.movedUnits = infantry.moved;
    }
    const refinery = await build('refinery', refineryTypes, [yard.uid, power.uid, barracks.uid]);
    report.refinery = refinery;
    const warFactory = await build('war-factory', warFactoryTypes, [yard.uid, power.uid, barracks.uid, refinery.uid]);
    report.warFactory = warFactory;
    if (!api.buildOnly) {
      const vehicles = await trainAndMove('vehicles', 'vehicle', combatVehicleTypes, 3, warFactory.uid);
      report.trainedVehicles = vehicles.trained;
      report.movedVehicles = vehicles.moved;
    }
    report.buildingsOnly = !!api.buildOnly;
    report.met = !api.buildOnly;
  } catch (error) {
    report.error = String(error);
    report.lastState = await api.commandState().catch(() => null);
    await shot('failure').catch(() => {});
    await record('base-play-failed', { error: report.error, lastState: report.lastState, met: false });
  } finally {
    await api.page.keyboard.up('Shift').catch(() => {});
    await api.page.keyboard.up('d').catch(() => {});
    await api.page.mouse.up({ button: 'left' }).catch(() => {});
    await api.page.mouse.up({ button: 'right' }).catch(() => {});
    report.finishedAt = new Date().toISOString();
    report.durationMs = performance.now() - started;
    await api.record?.('base-play-result', report);
  }
  return report;
}
