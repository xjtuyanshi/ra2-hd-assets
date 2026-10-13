import { setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';

// YR 1.001 observations already used by browser-battle-input.mjs. All writes
// belong to the ordinary browser input path, never these memory addresses.
const SIDEBAR = 0x87f7e8;
const STRIPS = SIDEBAR + 0x1544;
const STRIP_SIZE = 0xf94;
const PLACEMENT = SIDEBAR + 0x1174;
const CELL_VTABLE = 0x7e4eec;
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
  const infantryCount = api.trainInfantryCount ?? 10;
  const vehicleCount = api.trainVehicleCount ?? 10;
  for (const count of [infantryCount, vehicleCount])
    if (!Number.isInteger(count) || count < 1 || count > 30)
      throw new Error('Ordinary training counts must be integers from 1 to 30');
  report.buildTimings = [];
  const guard = async () => {
    await api.ownerIdle?.();
  };
  const record = async (name, proof) => {
    report.steps.push({ name, at: new Date().toISOString(), ...proof });
    await api.record?.(name, proof);
  };
  const memorySnapshot = async (stage) => {
    const result = spawnSync('/bin/ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8', timeout: 3000 });
    const candidates = (result.stdout || '')
      .split('\n')
      .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
      .filter((match) => match && /(?:^|[\\/\s])gamemd\.exe(?:\s|$)/i.test(match[3]))
      .map((match) => ({ pid: +match[1], rssBytes: +match[2] * 1024, command: match[3] }));
    await record('base-process-memory', {
      stage,
      source: 'Read-only macOS ps; preserve wrapper candidates for review',
      candidates,
      status: result.status,
    });
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
  let lastBrowserPoint = null;
  const move = async (point) => {
    await guard();
    const browser = await browserPoint(point);
    // The phase34 adapter already supplies one timed continuous path. Nesting
    // it inside another path would turn every small step into a full journey.
    if (api.page.mouse.move.name === 'humanMove') {
      await api.page.mouse.move(browser.x, browser.y);
      lastBrowserPoint = browser;
      return;
    }
    if (!lastBrowserPoint) {
      const pointer = (await peek()).sidebar.pointer;
      if (!pointer) throw new Error('An observed native pointer is required before continuous movement');
      lastBrowserPoint = await browserPoint(pointer);
    }
    const from = lastBrowserPoint;
    const distance = Math.hypot(browser.x - from.x, browser.y - from.y);
    // A practised player crosses the page in a few hundred milliseconds. Every
    // move follows a timed path; the existing click adapter still owns presses.
    const duration = Math.min(420, Math.max(120, distance * 0.22));
    const steps = Math.max(2, Math.ceil(duration / 8));
    const movementStarted = performance.now();
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      await api.page.mouse.move(from.x + (browser.x - from.x) * t, from.y + (browser.y - from.y) * t);
      const remaining = movementStarted + duration * t - performance.now();
      if (remaining > 0) await delay(remaining);
    }
    lastBrowserPoint = browser;
  };
  const click = async (point, button = 'left') => {
    await guard();
    await move(point);
    // Keep the existing battle helper's click adapter contract.
    await api.click(Math.round(point.x), Math.round(point.y), 'quick', button);
    await delay(80);
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
  const placement = async () => {
    const raw = await memory(PLACEMENT, 0x3c);
    return {
      center: { x: raw.readInt16LE(0), y: raw.readInt16LE(2) },
      offset: { x: raw.readInt16LE(4), y: raw.readInt16LE(6) },
      foundation: raw.readUInt32LE(8),
      proximity: raw[0xc] === 1,
      building: raw.readUInt32LE(0x30),
      type: raw.readUInt32LE(0x34),
      owner: raw.readInt32LE(0x38),
    };
  };
  const freeFoundations = async (state, anchors, preview, deadline) => {
    if (preview.foundation < 0x10000 || preview.foundation % 4 || !preview.building || !preview.type)
      throw new Error('The original game has not armed a real building foundation');
    const raw = await memory(preview.foundation, 120 * 4);
    const footprint = [];
    let complete = false;
    for (let index = 0; index < 120; index++) {
      const x = raw.readInt16LE(index * 4),
        y = raw.readInt16LE(index * 4 + 2);
      if (x === 0x7fff && y === 0x7fff) {
        complete = true;
        break;
      }
      if (Math.abs(x) > 10 || Math.abs(y) > 10) throw new Error('Implausible native placement footprint');
      footprint.push({ x: x + preview.offset.x, y: y + preview.offset.y });
    }
    if (!complete || !footprint.length) throw new Error('Native placement footprint is incomplete');
    const map = await memory(SIDEBAR + 0x13c, 8);
    const items = map.readUInt32LE(0),
      capacity = map.readInt32LE(4);
    if (items < 0x10000 || items % 4 || capacity < 1 || capacity > 512 * 512)
      throw new Error('Native map cell array is unavailable');
    // The native CanThisExistHere return at 0x47CA40 reads this Buildable byte.
    // No land class or occupation is changed by the driver.
    const land = await memory(0x89ea60, 12 * 36);
    const cells = new Map();
    const readCell = async (x, y) => {
      const key = `${x},${y}`;
      if (cells.has(key)) return cells.get(key);
      if (x < 0 || x >= 512 || y < 0 || y * 512 + x >= capacity) return null;
      const pointer = await u32(items + (y * 512 + x) * 4);
      if (pointer < 0x10000 || pointer % 4) return null;
      const bytes = await memory(pointer, 0x148);
      if (bytes.readUInt32LE(0) !== CELL_VTABLE || bytes.readInt16LE(0x24) !== x || bytes.readInt16LE(0x26) !== y)
        return null;
      const value = {
        x,
        y,
        pointer,
        level: bytes.readInt8(0x11b),
        slope: bytes[0x11c],
        land: bytes.readInt32LE(0xec),
        firstObject: bytes.readUInt32LE(0xe4),
        occupation: bytes.readUInt32LE(0x124),
        altFlags: bytes.readUInt32LE(0x12c),
        flags: bytes.readUInt32LE(0x140),
        overlay: bytes.readInt32LE(0x44),
      };
      cells.set(key, value);
      return value;
    };
    const candidates = new Map();
    for (const anchor of own(state).filter((object) => anchors.includes(object.uid))) {
      for (let dx = -6; dx <= 6; dx++)
        for (let dy = -6; dy <= 6; dy++) {
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          if (distance < 2) continue;
          const x = Math.floor(anchor.x / 256) + dx,
            y = Math.floor(anchor.y / 256) + dy;
          const key = `${x},${y}`,
            before = candidates.get(key);
          if (!before || distance < before.distance) candidates.set(key, { x, y, distance, anchorUid: anchor.uid });
        }
    }
    const available = [];
    for (const candidate of [...candidates.values()].sort(
      (a, b) => a.distance - b.distance || a.y - b.y || a.x - b.x,
    )) {
      if (performance.now() >= deadline) break;
      const ground = await readCell(candidate.x, candidate.y);
      if (!ground) continue;
      const point = project(
        { x: candidate.x * 256 + 128, y: candidate.y * 256 + 128, z: ground.level * 104 },
        state.view,
      );
      if (!tactical(point, state, 30)) continue;
      const observed = [];
      for (const offset of footprint) {
        const cell = await readCell(candidate.x + offset.x, candidate.y + offset.y);
        if (
          !cell ||
          cell.firstObject ||
          cell.occupation ||
          cell.slope ||
          cell.flags & 0x500 ||
          !(cell.altFlags & 8) ||
          cell.level !== ground.level ||
          cell.overlay !== -1 ||
          cell.land < 0 ||
          cell.land >= 12 ||
          !land[cell.land * 36]
        )
          break;
        observed.push(cell);
      }
      if (observed.length === footprint.length) available.push({ ...candidate, point, cells: observed });
      if (available.length >= 8) break;
    }
    return { footprint, candidates: available, scannedCells: cells.size };
  };
  const build = async (label, types, anchors) => {
    const buildStarted = performance.now();
    let state = await openTab(0);
    const cameo = state.sidebar.cameos.find(
      (value) => value.kind === 'building' && types.test(value.id) && !value.darkened,
    );
    if (!cameo)
      throw new Error(
        `The actual sidebar has no enabled ${label} cameo: ${state.sidebar.cameos.map((value) => value.id).join(', ')}`,
      );
    const before = await factory(cameo, 0);
    if (!cameo.ready && (!before.pointer || !before.object)) {
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
    const placementStarted = performance.now(),
      placementDeadline = placementStarted + 20000;
    await click(cameoPoint(ready.cameo, ready.state));
    const armed = await wait(
      'native armed ' + label + ' foundation',
      async () => {
        const value = await placement();
        return value.building === ready.factory.object && value.foundation ? value : null;
      },
      2000,
    );
    state = await peek();
    const search = await freeFoundations(state, anchors, armed, placementDeadline);
    await record('base-' + label + '-foundation-search', search);
    const attempts = [];
    for (const candidate of search.candidates) {
      if (performance.now() >= placementDeadline) break;
      state = await peek();
      const point = project(
        { x: candidate.x * 256 + 128, y: candidate.y * 256 + 128, z: candidate.cells[0].level * 104 },
        state.view,
      );
      await move(point);
      let preview = null;
      try {
        preview = await wait(
          'fresh native foundation preview',
          async () => {
            const value = await placement();
            return value.building === ready.factory.object &&
              value.center.x === candidate.x &&
              value.center.y === candidate.y
              ? value
              : null;
          },
          Math.min(1000, Math.max(1, placementDeadline - performance.now())),
        );
      } catch {
        /* A stale preview is unknown and never authorizes a placement click. */
      }
      const attempt = { cell: { x: candidate.x, y: candidate.y }, point, preview, clicked: false, placed: null };
      attempts.push(attempt);
      if (!preview?.proximity || preview.owner !== state.localHouse) continue;
      const previewFile = await shot(label + '-preview-' + attempts.length);
      attempt.previewFile = previewFile;
      await click(point);
      attempt.clicked = true;
      let placed = null;
      try {
        placed = await stateWait(
          'new owned ' + label,
          (next) =>
            own(next).find((value) => value.kind === 'building' && value.type === cameo.id && !previous.has(value.uid)),
          1500,
        );
      } catch {
        /* A real rejection or changed cell remains a failure, not a success. */
      }
      attempt.placed = placed?.observed ?? null;
      await record('base-' + label + '-placement-attempt', attempt);
      if (placed) {
        const completed = await stateWait(
          label + ' placed and construction complete',
          (next) => own(next).find((value) => value.uid === placed.observed.uid && constructionComplete(value)),
          15000,
        );
        const timing = {
          label,
          productionAndPlacementMs: performance.now() - buildStarted,
          placementMs: performance.now() - placementStarted,
          previewCount: attempts.length,
          placementClicks: attempts.filter((value) => value.clicked).length,
        };
        report.buildTimings.push(timing);
        await record('base-' + label + '-placed', {
          id: cameo.id,
          building: completed.observed,
          frame: completed.state.frame,
          attempts,
          timing,
          verified: true,
        });
        await shot(label + '-placed');
        return completed.observed;
      }
      if (!(await placement()).building) {
        const current = await peek();
        const currentCameo = current.sidebar.cameos.find((value) => value.id === cameo.id && value.ready);
        if (!currentCameo) throw new Error('Ready building disappeared after a real rejected placement');
        await click(cameoPoint(currentCameo, current));
      }
    }
    await shot(label + '-placement-failed');
    throw new Error(
      `No observed free ${label} footprint passed the native preview within 20000 ms: ${JSON.stringify(attempts)}`,
    );
  };

  const trainAndMove = async (label, kind, types, tab, originUid, count) => {
    let state = await openTab(tab);
    const cameo = state.sidebar.cameos.find((value) => value.kind === kind && types.test(value.id) && !value.darkened);
    if (!cameo) throw new Error(`The actual ${kind} tab has no enabled basic combat ${kind} cameo`);
    const previousUnits = new Set(
      own(state)
        .filter((value) => value.kind === kind)
        .map((value) => value.uid),
    );
    for (let index = 0; index < count; index++) {
      state = await peek();
      const current = state.sidebar.cameos.find((value) => value.id === cameo.id);
      if (!current) throw new Error(`The live ${kind} cameo disappeared while queuing units`);
      await click(cameoPoint(current, state));
      await record('base-' + label + '-train-click', { index: index + 1, id: cameo.id, frame: state.frame });
    }
    await shot(label + '-producing');
    const trained = await stateWait(
      count + ' newly trained owned ' + label,
      (next) => {
        const fresh = own(next).filter(
          (value) => value.kind === kind && value.type === cameo.id && !previousUnits.has(value.uid),
        );
        return fresh.length >= count ? fresh.slice(0, count) : null;
      },
      120000,
    );
    await record('base-' + label + '-trained', {
      id: cameo.id,
      units: trained.observed,
      frame: trained.state.frame,
      verified: true,
    });
    await shot(label + '-trained');
    // P is the original combat selection hotkey. It avoids clicking an emerging
    // tank through the factory roof and selects an ordinary mixed army for play.
    await key('p');
    await record('base-' + label + '-group-selection', { input: 'Ordinary P combat-unit selection', count });
    let retrySelectionAt = performance.now() + 750;
    const selected = await wait('all newly trained units selected', async () => {
      const next = await api.commandState();
      if (!next?.view) return null;
      const selectedUnits = own(next).filter(
        (value) => value.selected && trained.observed.some((unit) => unit.uid === value.uid),
      );
      if (selectedUnits.length === count) return { state: next, observed: selectedUnits };
      // Newly created vehicles can still be leaving the factory when P first
      // runs. A later exit does not automatically join the earlier selection.
      if (performance.now() >= retrySelectionAt) {
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
    await memorySnapshot('start');
    for (const [address, bytes] of [
      [0x4a8bf7, [0x8b, 0x83, 0x7c, 0x11, 0, 0]],
      [0x47ed82, [0xa0, 0x68, 0x09, 0x88, 0]],
      [0x47ca40, [0x8a, 0x04, 0x8d, 0x60, 0xea, 0x89, 0]],
    ]) {
      if (!(await memory(address, bytes.length)).equals(Buffer.from(bytes)))
        throw new Error('Pinned YR placement observation signature mismatch');
    }
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
      report.deploymentAtMs = performance.now();
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
    report.deploymentAtMs ??= performance.now();
    await shot('yard');
    const power = await build('power-plant', powerTypes, [yard.uid]);
    report.powerPlant = power;
    if (api.stopAfter === 'power-plant') {
      report.buildingsOnly = true;
      report.stoppedAfter = 'power-plant';
      return report;
    }
    const barracks = await build('barracks', barracksTypes, [yard.uid, power.uid]);
    report.barracks = barracks;
    const refinery = await build('refinery', refineryTypes, [yard.uid, power.uid, barracks.uid]);
    report.refinery = refinery;
    if (api.stopAfter === 'refinery') {
      report.buildingsOnly = true;
      report.stoppedAfter = 'refinery';
      return report;
    }
    const warFactory = await build('war-factory', warFactoryTypes, [yard.uid, power.uid, barracks.uid, refinery.uid]);
    report.warFactory = warFactory;
    report.deployToWarFactoryMs = performance.now() - report.deploymentAtMs;
    await record('base-build-sequence-time', {
      deployToWarFactoryMs: report.deployToWarFactoryMs,
      steps: report.buildTimings,
      source: 'Actual completed owned buildings after ordinary deploy/sidebar input',
    });
    if (api.stopAfter === 'war-factory') {
      report.buildingsOnly = true;
      report.stoppedAfter = 'war-factory';
      return report;
    }
    const secondRefinery = await build('second-refinery', refineryTypes, [
      yard.uid,
      power.uid,
      barracks.uid,
      refinery.uid,
      warFactory.uid,
    ]);
    report.secondRefinery = secondRefinery;
    if (api.buildRadar) {
      const anchors = [yard.uid, power.uid, barracks.uid, refinery.uid, warFactory.uid, secondRefinery.uid];
      // The same ordinary production and placement path builds the side's real
      // radar provider; a minimap click is meaningful only after it is powered.
      report.radarPowerPlant = await build('radar-power-plant', powerTypes, anchors);
      anchors.push(report.radarPowerPlant.uid);
      report.radarBuilding = await build('radar', /^(GAAIRC|AMRADR|NARADR|YAPSIS)$/, anchors);
      anchors.push(report.radarBuilding.uid);
      if ((await peek()).sidebar.power.low)
        report.additionalRadarPower = await build('radar-additional-power', powerTypes, anchors);
      await stateWait(
        'built and powered native radar',
        (next) => next.sidebar?.radarActive === true && next.sidebar.power.low === false,
        15000,
      );
      await shot('radar-active');
    }
    if (!api.buildOnly) {
      const infantry = await trainAndMove('infantry', 'infantry', infantryTypes, 2, barracks.uid, infantryCount);
      report.trainedUnits = infantry.trained;
      report.movedUnits = infantry.moved;
      const vehicles = await trainAndMove('vehicles', 'vehicle', combatVehicleTypes, 3, warFactory.uid, vehicleCount);
      report.trainedVehicles = vehicles.trained;
      report.movedVehicles = vehicles.moved;
      report.newlyTrainedCount = infantry.trained.length + vehicles.trained.length;
    }
    report.buildingsOnly = !!api.buildOnly;
    report.met = !api.buildOnly;
  } catch (error) {
    report.error = String(error);
    report.lastState = await api.commandState().catch(() => null);
    await shot('failure').catch(() => {});
    await record('base-play-failed', { error: report.error, lastState: report.lastState, met: false });
  } finally {
    await memorySnapshot('end');
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
