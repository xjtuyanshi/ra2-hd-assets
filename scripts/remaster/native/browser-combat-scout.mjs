import { setTimeout as delay } from 'node:timers/promises';
import { observePageCombat } from './page-battle-input.mjs';

const MOBILE_KINDS = new Set(['infantry', 'vehicle']);
const snapshot = (object) => ({
  uid: object.uid,
  kind: object.kind,
  type: object.type,
  owner: object.owner,
  selected: object.selected,
  health: object.health,
  x: object.x,
  y: object.y,
  z: object.z,
  mission: object.mission,
  queuedMission: object.queuedMission,
  destination: object.destination,
});
const selectedOwned = (state) =>
  state?.localHouse >= 0
    ? state.objects.filter(
        (object) =>
          object.owner === state.localHouse && object.selected && object.health > 0 && MOBILE_KINDS.has(object.kind),
      )
    : [];
const centroid = (objects) => {
  const zs = objects.map((object) => object.z).sort((a, b) => a - b);
  return {
    x: objects.reduce((sum, object) => sum + object.x, 0) / objects.length,
    y: objects.reduce((sum, object) => sum + object.y, 0) / objects.length,
    z: zs[Math.floor(zs.length / 2)],
  };
};

/**
 * Find actual local-visible combat by ordinary player scouting before the performance capture.
 * H/P/F are the owner's verified CenterBase/CombatantSelect/Follow bindings. No VM input shortcut,
 * hidden enemy position, shroud write, unit write or clock change is used.
 */
export async function scoutForCombat({ page, click, point, commandState, readBytes, record, shot }) {
  const started = performance.now(),
    deadline = started + 60_000;
  const held = new Set();
  // The caller enters this helper in a fresh battle, whose Follow mode starts off. No diagnostic exposes the flag;
  // retain that explicit precondition and the parity of this helper's actual F key-downs instead of claiming a read.
  let followArmed = false;
  const report = {
    met: false,
    startedAtMs: started,
    maxDurationMs: 60_000,
    maxWaypoints: 4,
    input: 'real browser H/P/F, ordinary left ground clicks and bounded arrow-key camera movement',
    geometry: {
      centerVerified: false,
      source: 'src/games/renderState.ts: GameRenderMap exposes fileName only',
      mapCenter: null,
      policy: 'already-visible local shroud frontier; no global map-center assumption',
      terrainPassability: 'not exposed; native Move order and movement must prove each accepted ground click',
    },
    actions: [],
    selection: null,
    followMode: { initial: "off in the caller's fresh battle", flagReadable: false, toggles: [], cleanup: null },
    waypoints: [],
    combatSamples: [],
    error: null,
  };
  const key = async (name, ms = 120, cleanup = false) => {
    if (!cleanup && performance.now() >= deadline) throw new Error('Combat scouting deadline reached');
    held.add(name);
    await page.keyboard.down(name);
    if (name === 'f') followArmed = !followArmed;
    try {
      await delay(cleanup || name === 'f' ? ms : Math.min(ms, Math.max(0, deadline - performance.now())));
    } finally {
      await page.keyboard.up(name);
      held.delete(name);
    }
    report.actions.push({ key: name, heldMs: ms, atMs: performance.now() - started });
  };
  const releaseHeld = async () => {
    for (const name of [...held]) {
      try {
        await page.keyboard.up(name);
        held.delete(name);
      } catch {
        // The caller owns browser/game cleanup after a disconnected page.
      }
    }
  };
  const follow = async (armed, phase, cleanup = false) => {
    if (followArmed === armed) return;
    const mode = { phase, requestedArmed: armed, beforeView: null, afterView: null, sent: false };
    report.followMode.toggles.push(mode);
    try {
      try {
        mode.beforeView = (await commandState())?.view ?? null;
      } catch (error) {
        mode.beforeViewError = String(error);
      }
      await key('f', 120, cleanup);
      mode.sent = true;
      try {
        mode.afterView = (await commandState())?.view ?? null;
      } catch (error) {
        mode.afterViewError = String(error);
      }
    } finally {
      mode.expectedArmedFromInputParity = followArmed;
      mode.viewChanged =
        !!mode.beforeView &&
        !!mode.afterView &&
        (mode.beforeView.x !== mode.afterView.x || mode.beforeView.y !== mode.afterView.y);
    }
  };
  const observe = (zFactor) =>
    page.evaluate(
      ({ source, zFactor }) => {
        const read = new Function(`return (${source});`)();
        const result = read(window.__hdBridge?.diagnostics?.combatState, zFactor);
        return {
          frame: result.frame,
          view: result.view ?? null,
          bounds: result.bounds ?? null,
          visible: result.visible,
          inView: result.inView,
          effects: result.effects.filter((effect) => effect.inView).slice(0, 16),
        };
      },
      { source: observePageCombat.toString(), zFactor },
    );
  let consecutive = 0;
  const sampleCombat = async (zFactor) => {
    const combat = await observe(zFactor);
    const sample = { atMs: performance.now() - started, ...combat };
    if (report.combatSamples.length < 250) report.combatSamples.push(sample);
    consecutive = combat.inView > 0 ? consecutive + 1 : 0;
    if (consecutive >= 3) {
      report.met = true;
      report.combat = sample;
    }
    return combat;
  };
  const panOwnedIntoView = async (objects, state, zFactor) => {
    let view = state.view;
    const center = centroid(objects);
    const sidebar = state.sidebar;
    if (!view || !sidebar) return;
    const side = sidebar.layout.sidebar,
      left = side.x === 0 ? side.width : 0,
      right = side.x > 0 ? side.x : sidebar.frame.width,
      bottom = sidebar.layout.commandBar?.y ?? sidebar.frame.height,
      screenCenter = { x: (left + right) / 2, y: bottom / 2 };
    const [px, py] = await point(screenCenter.x, screenCenter.y);
    await page.mouse.move(px, py);
    for (let attempt = 0; attempt < 2 && performance.now() < deadline; attempt++) {
      const x = Math.trunc((30 * (center.x - center.y)) / 256) - view.x,
        y =
          Math.trunc((15 * (center.x + center.y)) / 256) -
          Math.trunc(center.z * zFactor + (center.z >= 728 ? 1 : 0) + 0.5) -
          view.y;
      if (x >= left + 48 && x < right - 48 && y >= 48 && y < bottom - 48) return;
      const dx = x - screenCenter.x,
        dy = y - screenCenter.y,
        horizontal = Math.abs(dx) > Math.abs(dy),
        delta = horizontal ? dx : dy,
        arrow = horizontal ? (delta > 0 ? 'ArrowRight' : 'ArrowLeft') : delta > 0 ? 'ArrowDown' : 'ArrowUp';
      const before = view;
      await key(arrow, Math.min(350, Math.max(80, Math.abs(delta) * 0.5)));
      const next = await commandState();
      report.actions.push({ camera: arrow, before, after: next?.view ?? null, selectedCentroid: center });
      if (!next?.view) return;
      view = next.view;
    }
  };
  const planMove = (selected, anchor, visited, zFactor) =>
    page.evaluate(
      ({ selected, anchor, visited, zFactor }) => {
        const state = window.__hdBridge?.diagnostics?.combatState;
        if (!state?.view || !state.shroud || !state.sidebar) return { error: 'Native view/shroud/sidebar unavailable' };
        const shroud = state.shroud,
          side = state.sidebar.layout.sidebar,
          left = side.x === 0 ? side.width : 0,
          right = side.x > 0 ? side.x : state.sidebar.frame.width,
          bottom = state.sidebar.layout.commandBar?.y ?? state.sidebar.frame.height;
        const center = {
          x: selected.reduce((sum, object) => sum + object.x, 0) / selected.length,
          y: selected.reduce((sum, object) => sum + object.y, 0) / selected.length,
          z: selected.map((object) => object.z).sort((a, b) => a - b)[Math.floor(selected.length / 2)],
        };
        if (![center.x, center.y, center.z, left, right, bottom].every(Number.isFinite))
          return { error: 'Invalid observed local geometry' };
        const level = Math.trunc(center.z / 104),
          shift = Math.trunc(level / 2) + Number(!!(level & 1));
        const candidates = [];
        for (let y = 0; y < shroud.height; y++) {
          for (let x = 0; x < shroud.width; x++) {
            // A genuinely visible flat cell is stronger evidence than merely mapped/fogged terrain.
            if (shroud.cells[y * shroud.width + x] !== 2) continue;
            const flat = { x: shroud.originX + x, y: shroud.originY + y };
            const cell = { x: flat.x + shift, y: flat.y + shift };
            if (visited.some((previous) => Math.hypot(previous.x - cell.x, previous.y - cell.y) < 2)) continue;
            const world = { x: (cell.x + 0.5) * 256, y: (cell.y + 0.5) * 256, z: center.z };
            const distance = Math.hypot(world.x - center.x, world.y - center.y);
            if (distance < 2 * 256 || distance > 8 * 256) continue;
            const pixel = {
              x: Math.trunc((30 * (world.x - world.y)) / 256) - state.view.x,
              y:
                Math.trunc((15 * (world.x + world.y)) / 256) -
                Math.trunc(world.z * zFactor + (world.z >= 728 ? 1 : 0) + 0.5) -
                state.view.y,
            };
            if (pixel.x < left + 48 || pixel.x >= right - 48 || pixel.y < 48 || pixel.y >= bottom - 48) continue;
            let frontier = 0;
            for (const [dx, dy] of [
              [-1, 0],
              [1, 0],
              [0, -1],
              [0, 1],
            ]) {
              const nx = x + dx,
                ny = y + dy;
              if (
                nx >= 0 &&
                ny >= 0 &&
                nx < shroud.width &&
                ny < shroud.height &&
                shroud.cells[ny * shroud.width + nx] === 0
              )
                frontier++;
            }
            // Prefer a visible frontier farther from the initial selected troops. This is exploration,
            // not a claimed global map center or an inferred enemy location.
            const score = frontier * 1024 + Math.hypot(world.x - anchor.x, world.y - anchor.y);
            candidates.push({
              pixel,
              cell,
              flatCell: flat,
              visibleCellState: 2,
              assumedLocalHeight: center.z,
              frontier,
              score,
            });
          }
        }
        candidates.sort((a, b) => b.score - a.score);
        return {
          frame: state.frame,
          view: state.view,
          selectedCentroid: center,
          bounds: { left, top: 0, right, bottom },
          candidateCount: candidates.length,
          candidate: candidates[0] ?? null,
          error: candidates.length
            ? null
            : 'No distinct already-visible nearby ground waypoint inside the tactical view',
        };
      },
      { selected: selected.map(snapshot), anchor, visited, zFactor },
    );
  try {
    const zFactor = Buffer.from(await readBytes(0xb0cd48, 8)).readDoubleLE();
    if (!Number.isFinite(zFactor) || zFactor <= 0 || zFactor > 4) throw new Error('Invalid native height projection');
    report.zFactor = zFactor;
    report.geometry.scenario = await page.evaluate(() => window.__hdBridge?.timeline?.map ?? null);
    await key('h');
    await key('p');
    let state = null,
      selected = [];
    const selectionDeadline = Math.min(deadline, performance.now() + 3000);
    do {
      state = await commandState();
      selected = selectedOwned(state);
      if (selected.length >= 3) break;
      await delay(100);
    } while (performance.now() < selectionDeadline);
    report.selection = {
      frame: state?.frame ?? null,
      localHouse: state?.localHouse ?? null,
      selectedOwnedCombat: selected.length,
      interpretation:
        'native P CombatantSelect; verify selected, alive, owned infantry/vehicles from command diagnostics',
      objects: selected.map(snapshot),
    };
    if (selected.length < 3)
      throw new Error('Native CombatantSelect did not select at least three owned ground combat units');
    await record?.('combat-scout-selection', report.selection);
    const anchor = centroid(selected),
      visited = [];
    for (let index = 0; index < 4 && performance.now() < deadline && !report.met; index++) {
      const waypointDeadline = Math.min(deadline, performance.now() + 15_000);
      state = await commandState();
      selected = selectedOwned(state);
      if (selected.length < 3) throw new Error('Fewer than three selected owned ground combat units remain');
      // Native Follow is a toggle and suppresses ordinary camera arrows while armed.
      await follow(false, 'before-waypoint-camera');
      await panOwnedIntoView(selected, state, zFactor);
      const plan = await planMove(selected, anchor, visited, zFactor);
      const waypoint = {
        index: index + 1,
        startedAtMs: performance.now() - started,
        plan,
        before: selected.map(snapshot),
        samples: [],
      };
      report.waypoints.push(waypoint);
      if (!plan.candidate) throw new Error(plan.error);
      visited.push(plan.candidate.cell);
      const beforeByUid = new Map(selected.map((object) => [object.uid, snapshot(object)]));
      // Native sidebar modes are not a normal ground Move and must not be clicked through.
      if (state.sidebar?.modes.repair || state.sidebar?.modes.sell)
        throw new Error('A native repair/sell cursor mode is armed');
      await click(plan.candidate.pixel.x, plan.candidate.pixel.y, 'quick', 'left');
      waypoint.input = { button: 'left', mode: 'ordinary ground Move', point: plan.candidate.pixel };
      const orders = new Map();
      const orderDeadline = Math.min(waypointDeadline, performance.now() + 3000);
      do {
        const after = await commandState();
        for (const object of selectedOwned(after)) {
          const before = beforeByUid.get(object.uid);
          if (!before || object.destination?.kind !== 'cell') continue;
          const changed = JSON.stringify(before.destination) !== JSON.stringify(object.destination),
            moving = /^(Move|QMove)$/.test(object.mission) || /^(Move|QMove)$/.test(object.queuedMission ?? ''),
            nearClick =
              Math.abs(object.destination.x - plan.candidate.cell.x) <= 2 &&
              Math.abs(object.destination.y - plan.candidate.cell.y) <= 2;
          if (changed && moving && nearClick && !orders.has(object.uid))
            orders.set(object.uid, {
              frame: after.frame,
              before,
              ordered: snapshot(object),
              formationToleranceCells: 2,
            });
          const order = orders.get(object.uid);
          if (!order) continue;
          const target = { x: (order.ordered.destination.x + 0.5) * 256, y: (order.ordered.destination.y + 0.5) * 256 },
            displacement = Math.hypot(object.x - before.x, object.y - before.y),
            beforeDistance = Math.hypot(before.x - target.x, before.y - target.y),
            afterDistance = Math.hypot(object.x - target.x, object.y - target.y);
          if (displacement >= 32 && afterDistance <= beforeDistance - 16)
            waypoint.motionNativeEvidence = {
              ...order,
              after: snapshot(object),
              afterFrame: after.frame,
              displacement,
              beforeDistance,
              afterDistance,
            };
        }
        if (waypoint.samples.length < 16)
          waypoint.samples.push({
            frame: after?.frame ?? null,
            view: after?.view ?? null,
            selected: selectedOwned(after).map(snapshot),
          });
        await sampleCombat(zFactor);
        if (waypoint.motionNativeEvidence) break;
        await delay(Math.min(150, Math.max(0, orderDeadline - performance.now())));
      } while (performance.now() < orderDeadline);
      waypoint.observedOrders = [...orders.values()];
      if (!waypoint.motionNativeEvidence) {
        waypoint.error = 'No changed native cell destination plus movement toward that order was observed';
        waypoint.finishedAtMs = performance.now() - started;
        await record?.('combat-scout-waypoint', waypoint);
        continue;
      }
      const followBefore = await commandState();
      await follow(true, 'follow-moving-scouts');
      let nextMotionSampleAt = 0;
      while (performance.now() < waypointDeadline && !report.met) {
        await sampleCombat(zFactor);
        if (performance.now() >= nextMotionSampleAt) {
          const after = await commandState();
          if (waypoint.samples.length < 32)
            waypoint.samples.push({
              frame: after?.frame ?? null,
              view: after?.view ?? null,
              selected: selectedOwned(after).map(snapshot),
            });
          waypoint.follow = {
            before: followBefore?.view ?? null,
            after: after?.view ?? null,
            frame: after?.frame ?? null,
          };
          nextMotionSampleAt = performance.now() + 1000;
        }
        await delay(Math.min(250, Math.max(0, waypointDeadline - performance.now())));
      }
      waypoint.finishedAtMs = performance.now() - started;
      await record?.('combat-scout-waypoint', waypoint);
    }
    if (!report.met)
      report.error =
        'No persistent actual local-visible weapon effects found within four visible-ground scouting waypoints';
    if (report.met) report.screenshot = await shot?.('scout-visible-fight');
  } catch (error) {
    report.met = false;
    report.error = String(error?.stack ?? error);
  } finally {
    await releaseHeld();
    try {
      await follow(false, 'final-restore-off', true);
      report.followMode.cleanup = { expectedOffFromInputParity: !followArmed, flagReadable: false };
    } catch (error) {
      report.met = false;
      report.followMode.cleanup = {
        expectedOffFromInputParity: !followArmed,
        flagReadable: false,
        error: String(error),
      };
      report.error ??= `Follow-mode cleanup failed: ${String(error)}`;
    }
    // A failed release in the restore press itself must receive the same final key-up attempt.
    await releaseHeld();
    report.finishedAtMs = performance.now();
    report.durationMs = report.finishedAtMs - started;
    await record?.('combat-scout', report);
  }
  return report;
}
