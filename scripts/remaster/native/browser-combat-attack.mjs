import { setTimeout as delay } from 'node:timers/promises';
import { observePageCombat } from './page-battle-input.mjs';

function visibleBattleObservation({ localHouse, allies, zFactor, minHealth, combatUnits }) {
  const diagnostics = window.__hdBridge?.diagnostics;
  const state = diagnostics?.state;
  if (!diagnostics?.enabled || !diagnostics?.shown || !state?.view || !state.shroud || !state.sidebar)
    return { error: 'Actual visible HD battle state, native shroud or sidebar is unavailable' };
  if (performance.now() - diagnostics.counters.lastStateAtMs > 500) return { error: 'Native render state is stale' };
  const side = state.sidebar.layout.sidebar;
  const bounds = {
    left: side.x === 0 ? side.width : 0,
    right: side.x > 0 ? side.x : state.sidebar.frame.width,
    top: 0,
    bottom: state.sidebar.layout.commandBar?.y ?? state.sidebar.frame.height,
  };
  const objects = [];
  for (const object of state.objects) {
    // Neither hidden/fogged enemy coordinates nor neutral/special houses leave this observer.
    if (
      !Number.isInteger(object.owner) ||
      object.owner < 0 ||
      object.owner > 5 ||
      object.health <= 0 ||
      object.nativeHidden === true ||
      (object.translucent !== undefined && object.translucent < 0.9) ||
      ![object.x, object.y, object.z].every(Number.isFinite)
    )
      continue;
    const ownInfantry =
      object.owner === localHouse && (object.kind === 'infantry' || (combatUnits && object.kind === 'vehicle'));
    const enemyBuilding =
      object.owner !== localHouse &&
      !allies.includes(object.owner) &&
      (object.kind === 'building' || (combatUnits && ['infantry', 'vehicle'].includes(object.kind))) &&
      object.health >= minHealth &&
      (object.kind !== 'building' || object.buildState === undefined || object.buildState === 'done');
    if (!ownInfantry && !enemyBuilding) continue;
    const level = Math.trunc(object.z / 104);
    const shift = Math.trunc(level / 2) + Number(!!(level & 1));
    const cellX = Math.trunc(object.x / 256) - shift;
    const cellY = Math.trunc(object.y / 256) - shift;
    const flatCells = [{ x: cellX, y: cellY }];
    if (level & 1) flatCells.push({ x: cellX + 1, y: cellY + 1 });
    const cellEvidence = flatCells.map((cell) => {
      const x = cell.x - state.shroud.originX;
      const y = cell.y - state.shroud.originY;
      return {
        ...cell,
        state:
          x >= 0 && y >= 0 && x < state.shroud.width && y < state.shroud.height
            ? state.shroud.cells[y * state.shroud.width + x]
            : 0xff,
      };
    });
    if (!cellEvidence.some((cell) => cell.state === 2)) continue;
    const worldPixel = {
      x: Math.trunc((30 * (object.x - object.y)) / 256),
      y:
        Math.trunc((15 * (object.x + object.y)) / 256) -
        Math.trunc(object.z * zFactor + (object.z >= 728 ? 1 : 0) + 0.5),
    };
    const pixel = { x: worldPixel.x - state.view.x, y: worldPixel.y - state.view.y };
    const tooltip = state.sidebar.tooltip?.rect;
    const coveredByTooltip =
      tooltip &&
      pixel.x >= tooltip.x &&
      pixel.x < tooltip.x + tooltip.width &&
      pixel.y >= tooltip.y &&
      pixel.y < tooltip.y + tooltip.height;
    objects.push({
      uid: object.uid,
      kind: object.kind,
      type: object.type,
      owner: object.owner,
      health: object.health,
      x: object.x,
      y: object.y,
      z: object.z,
      nativeHidden: false,
      nativeHiddenSource: object.nativeHidden === false ? 'explicit false' : 'ordinary omitted draw gate',
      cellEvidence,
      worldPixel,
      pixel,
      inView:
        !coveredByTooltip &&
        pixel.x >= bounds.left + 48 &&
        pixel.x < bounds.right - 48 &&
        pixel.y >= 48 &&
        pixel.y < bounds.bottom - 48,
    });
  }
  return { frame: state.frame, view: state.view, bounds, objects };
}

const commandObject = (object) =>
  object
    ? {
        uid: object.uid,
        type: object.type,
        kind: object.kind,
        owner: object.owner,
        health: object.health,
        selected: object.selected,
        mission: object.mission,
        queuedMission: object.queuedMission,
        target: object.target,
        destination: object.destination,
        x: object.x,
        y: object.y,
        z: object.z,
      }
    : null;

/** Establish one ordinary attack using only already-visible enemy information and trusted browser input. */
export async function attackVisibleEnemyBuilding({
  page,
  click: trustedClick,
  point,
  commandState,
  readBytes: nativeReadBytes,
  record,
  shot: screenshot,
  alliedHouses,
  combatUnits = false,
  selectedGroup = false,
  seconds = 600,
  inputState,
  ownerIdle,
}) {
  if (selectedGroup)
    return fightToVictory({
      page,
      click: trustedClick,
      point,
      commandState,
      readBytes: nativeReadBytes,
      record,
      shot: screenshot,
      alliedHouses,
      seconds,
      inputState,
      ownerIdle,
    });
  const started = performance.now();
  const deadline = started + 60_000;
  const held = new Set();
  const tried = new Set();
  const report = {
    met: false,
    fired: false,
    startedAtMs: started,
    maxDurationMs: 60_000,
    maxCandidates: 3,
    input: 'trusted browser mouse clicks and bounded arrow-key camera movement',
    policy: combatUnits
      ? 'one local infantry/vehicle attacks a local-shroud-visible non-allied six-player combat unit/building; no force fire'
      : 'one local infantry attacks a local-shroud-visible, non-allied six-player building; no force fire',
    alliedHouses,
    attempts: [],
    camera: [],
    error: null,
  };
  const emit = async (name, proof) => record?.(name, proof);
  const remaining = () => Math.max(0, deadline - performance.now());
  const sleep = async (ms) => delay(Math.min(ms, remaining()));
  const key = async (name, ms) => {
    if (!remaining()) throw new Error('Visible-enemy attack deadline reached');
    await command();
    held.add(name);
    try {
      await page.keyboard.down(name);
      await sleep(ms);
    } finally {
      await page.keyboard.up(name);
      held.delete(name);
    }
  };
  const command = async () => {
    if (!remaining()) throw new Error('Visible-enemy attack deadline reached');
    const state = await commandState();
    if (!state?.view || !Number.isInteger(state.localHouse) || state.localHouse < 0 || state.localHouse > 5)
      throw new Error('Actual six-player local command state is unavailable');
    if (report.localHouse !== undefined && state.localHouse !== report.localHouse)
      throw new Error('Actual local house changed during the bounded attack helper');
    if (state.sidebar?.modes?.repair || state.sidebar?.modes?.sell) throw new Error('Native repair/sell mode is armed');
    return state;
  };
  const click = async (...args) => {
    await command();
    return trustedClick(...args);
  };
  const readBytes = async (...args) => {
    await command();
    return nativeReadBytes(...args);
  };
  const shot = async (...args) => {
    await command();
    return screenshot?.(...args);
  };
  const observe = async (localHouse, zFactor, minHealth = 0.7) => {
    await command();
    return page.evaluate(visibleBattleObservation, {
      localHouse,
      allies: alliedHouses,
      zFactor,
      minHealth,
      combatUnits,
    });
  };
  const at = async (pixel) => {
    await command();
    const value = await point(Math.round(pixel.x), Math.round(pixel.y));
    const position = Array.isArray(value) ? { x: value[0], y: value[1] } : value;
    await command();
    const exposed = await page.evaluate(({ x, y }) => {
      const screen = document.querySelector('#screen');
      return document.elementFromPoint(x, y) === screen;
    }, position);
    if (!exposed) throw new Error('A browser UI overlay covers the intended native tactical input');
    return position;
  };
  const effects = async (zFactor) => {
    await command();
    return page.evaluate(
      ({ source, zFactor }) => {
        const diagnostics = window.__hdBridge?.diagnostics;
        const state = diagnostics?.state;
        if (
          !diagnostics?.enabled ||
          !diagnostics.shown ||
          !state?.effects ||
          performance.now() - diagnostics.counters.lastStateAtMs > 500
        )
          throw new Error('Actual firing render state is unavailable or stale');
        const observeCombat = (0, eval)(`(${source})`);
        const observation = observeCombat(state, zFactor);
        const raw = [...state.effects.bullets, ...(state.effects.anims ?? [])];
        return {
          ...observation,
          keys: raw.map((effect) => `${effect.id}:${effect.uid}`),
          effects: observation.effects
            .filter((effect) => effect.inView && ['bullet', 'muzzle'].includes(effect.kind))
            .map((effect) => {
              const original = raw.find((item) => item.id === effect.id && item.uid === effect.uid);
              return {
                ...effect,
                owner: original?.owner ?? null,
                attachedTo: original?.attachedTo ?? null,
                firer: original?.firer ?? null,
              };
            }),
        };
      },
      { source: observePageCombat.toString(), zFactor },
    );
  };
  const firing = async (attempt, infantry, building, zFactor, baseline) => {
    const firingStarted = performance.now();
    const until = Math.min(deadline, firingStarted + 15_000);
    const seen = new Set(baseline.keys);
    const proof = {
      fired: false,
      maxDurationMs: 15_000,
      baselineFrame: baseline.frame,
      selectedUid: infantry.uid,
      targetUid: building.uid,
      samples: [],
      correlatedEffects: [],
      correlationPolicy:
        'Fresh camera/shroud-visible own effect, exact selected UID attachment/firer, actual target health loss',
      bulletFirerContract: 'Absent from render contract; validated native bullet pointer +0xb0 when needed',
    };
    attempt.firing = proof;
    try {
      do {
        const actualState = await command();
        const actual = actualState.objects.find(
          (object) => object.uid === infantry.uid && object.owner === report.localHouse,
        );
        const target = actualState.objects.find(
          (object) => object.uid === building.uid && object.owner === building.owner,
        );
        const observed = await effects(zFactor);
        const visible = await observe(report.localHouse, zFactor, 0);
        const visibleInfantry = visible.objects?.find((object) => object.uid === infantry.uid && object.inView);
        const visibleTarget = visible.objects?.find((object) => object.uid === building.uid && object.inView);
        const attack =
          actual?.selected &&
          actual.health > 0 &&
          (actual.mission === 'Attack' || actual.queuedMission === 'Attack') &&
          actual.target?.kind === 'object' &&
          actual.target.uid === building.uid;
        const fresh = observed.effects.filter((effect) => !seen.has(`${effect.id}:${effect.uid}`));
        for (const effect of fresh) {
          if (!attack || !visibleInfantry || !visibleTarget) continue;
          let correlation =
            effect.attachedTo?.uid === infantry.uid
              ? 'render attachedTo UID'
              : effect.firer?.uid === infantry.uid
                ? 'render firer UID'
                : null;
          if (!correlation && effect.kind === 'bullet' && Number.isSafeInteger(effect.id) && effect.id > 0) {
            // Validate both sides of the read: short-lived native effects can be freed/reused between polls.
            await command();
            const header = Buffer.from(await readBytes(effect.id, 0xb4));
            const uid = header.readUInt32LE(0x10),
              firer = header.readUInt32LE(0xb0);
            if (uid === effect.uid && firer > 0) {
              await command();
              const ownerUid = Buffer.from(await readBytes(firer + 0x10, 4)).readUInt32LE();
              await command();
              const currentUid = Buffer.from(await readBytes(effect.id + 0x10, 4)).readUInt32LE();
              if (currentUid === effect.uid && ownerUid === infantry.uid) {
                correlation = 'validated native bullet firer UID';
                effect.nativeFirer = { id: firer, uid: ownerUid, effectUidBefore: uid, effectUidAfter: currentUid };
              }
            }
          }
          if (correlation)
            proof.correlatedEffects.push({
              ...effect,
              correlation,
              ownership: { rawOwner: effect.owner, authoritativeSelectedUidOwner: report.localHouse },
              frame: observed.frame,
              view: observed.view,
              selectedVisible: visibleInfantry,
              targetVisible: visibleTarget,
            });
        }
        for (const id of observed.keys) seen.add(id);
        const sample = {
          frame: actualState.frame,
          effectFrame: observed.frame,
          infantry: commandObject(actual),
          building: commandObject(target),
          freshEffects: fresh.length,
          correlatedEffects: proof.correlatedEffects.length,
          cameraAndShroudVisible: !!visibleInfantry && !!visibleTarget,
        };
        if (proof.samples.length < 80) proof.samples.push(sample);
        if (
          attack &&
          visibleInfantry &&
          visibleTarget &&
          target?.health < attempt.before.building.health &&
          proof.correlatedEffects.length
        ) {
          await command();
          proof.screenshot = await shot?.(`harass-${attempt.index}-firing`);
          proof.fired = true;
          proof.targetHealthBefore = attempt.before.building.health;
          proof.targetHealthAfter = target.health;
          proof.after = sample;
          report.fired = true;
          report.firingProof = proof;
          break;
        }
        await sleep(100);
      } while (performance.now() < until);
    } catch (error) {
      proof.error = String(error?.stack ?? error);
    }
    proof.finishedAtMs = performance.now();
    proof.durationMs = proof.finishedAtMs - firingStarted;
  };
  const pairs = (observation, localHouse) => {
    if (observation.error) return [];
    const own = observation.objects.filter(
      (object) =>
        object.owner === localHouse && (object.kind === 'infantry' || (combatUnits && object.kind === 'vehicle')),
    );
    const enemies = observation.objects.filter(
      (object) =>
        object.owner !== localHouse &&
        (object.kind === 'building' || (combatUnits && ['infantry', 'vehicle'].includes(object.kind))),
    );
    const result = [];
    for (const infantry of own)
      for (const building of enemies) {
        const distanceCells = Math.hypot(infantry.x - building.x, infantry.y - building.y) / 256;
        const spanX = Math.abs(infantry.worldPixel.x - building.worldPixel.x);
        const spanY = Math.abs(infantry.worldPixel.y - building.worldPixel.y);
        if (
          distanceCells <= 14 &&
          spanX < observation.bounds.right - observation.bounds.left - 120 &&
          spanY < observation.bounds.bottom - 120 &&
          !tried.has(`${infantry.uid}:${building.uid}`)
        )
          result.push({ infantry, building, distanceCells });
      }
    return result.sort((a, b) => a.distanceCells - b.distanceCells || b.building.health - a.building.health);
  };
  try {
    if (
      !Array.isArray(alliedHouses) ||
      alliedHouses.some((house) => !Number.isInteger(house) || house < 0 || house > 5)
    )
      throw new Error('Caller must supply the actual six-player house-mask-derived allies');
    const zFactor = Buffer.from(await readBytes(0xb0cd48, 8)).readDoubleLE();
    if (!Number.isFinite(zFactor) || zFactor <= 0 || zFactor > 4) throw new Error('Invalid native height projection');
    report.zFactor = zFactor;
    let state = await command();
    report.localHouse = state.localHouse;
    const initial = await observe(state.localHouse, zFactor);
    if (initial.error) throw new Error(initial.error);
    const toggle = page.locator('#vm-controls-toggle');
    await command();
    const toolbar = await page.evaluate(() => {
      const toggle = document.querySelector('#vm-controls-toggle');
      const rect = toggle?.getBoundingClientRect();
      const hit = rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return {
        fullscreen: document.fullscreenElement?.id === 'screen-frame',
        expanded: toggle?.getAttribute('aria-expanded') === 'true',
        exposed: !!rect?.width && !!rect.height && !!hit && toggle.contains(hit),
      };
    });
    report.toolbar = toolbar;
    // Fullscreen exposes the native canvas while leaving ordinary page controls
    // behind it. Do not wait for a hidden toolbar which needs no collapsing.
    if (!toolbar.fullscreen && toolbar.expanded && toolbar.exposed) {
      await command();
      await toggle.click({ timeout: 1000 });
    }
    const center = {
      x: (initial.bounds.left + initial.bounds.right) / 2,
      y: (initial.bounds.top + initial.bounds.bottom) / 2,
    };
    await at(center);
    // Genuine right-click cancels any pending placement/order and focuses the native canvas before selection.
    await click(center.x, center.y, 'quick', 'right', 80);
    const focus = await page.evaluate(() => ({
      canvasFocused: document.activeElement === document.querySelector('#screen'),
      documentFocused: document.hasFocus(),
    }));
    await emit('combat-attack-focus', focus);
    if (!focus.canvasFocused || !focus.documentFocused) throw new Error('Trusted canvas input did not restore focus');
    for (let index = 0; index < 3 && remaining() && !report.met; index++) {
      state = await command();
      const observation = await observe(state.localHouse, zFactor);
      const pair = pairs(observation, state.localHouse)[0];
      if (!pair) {
        report.error =
          observation.error ?? 'No nearby, already-visible high-health enemy building and local infantry pair';
        break;
      }
      tried.add(`${pair.infantry.uid}:${pair.building.uid}`);
      const attempt = { index: index + 1, initial: { frame: observation.frame, ...pair }, samples: [] };
      report.attempts.push(attempt);
      try {
        let visible = observation;
        for (let pan = 0; pan < 10 && remaining(); pan++) {
          const infantry = visible.objects.find((object) => object.uid === pair.infantry.uid);
          const building = visible.objects.find((object) => object.uid === pair.building.uid);
          if (!infantry || !building) throw new Error('Previously visible candidate is no longer eligible/visible');
          if (infantry.inView && building.inView) break;
          const dx = (infantry.pixel.x + building.pixel.x) / 2 - (visible.bounds.left + visible.bounds.right) / 2;
          const dy = (infantry.pixel.y + building.pixel.y) / 2 - visible.bounds.bottom / 2;
          const horizontal = Math.abs(dx) >= Math.abs(dy);
          const offset = horizontal ? dx : dy;
          const arrow = horizontal ? (offset > 0 ? 'ArrowRight' : 'ArrowLeft') : offset > 0 ? 'ArrowDown' : 'ArrowUp';
          const beforeView = visible.view;
          const heldMs = Math.min(350, Math.max(80, Math.abs(offset) * 0.6));
          await key(arrow, heldMs);
          await sleep(100);
          visible = await observe(state.localHouse, zFactor);
          if (visible.error) throw new Error(visible.error);
          report.camera.push({ candidate: index + 1, arrow, heldMs, beforeView, afterView: visible.view });
          if (beforeView.x === visible.view.x && beforeView.y === visible.view.y)
            throw new Error('Real arrow input did not move the camera; no focus/follow assumption is made');
        }
        let infantry = visible.objects.find((object) => object.uid === pair.infantry.uid && object.inView);
        let building = visible.objects.find((object) => object.uid === pair.building.uid && object.inView);
        if (!infantry || !building) throw new Error('Both visible candidates could not fit into the tactical view');
        state = await command();
        await at(infantry.pixel);
        await click(infantry.pixel.x, infantry.pixel.y, 'quick', 'right', 80);
        await sleep(120);
        const cancelled = await command();
        if (cancelled.objects.some((object) => object.owner === cancelled.localHouse && object.selected))
          throw new Error('Ordinary right-click did not clear the previous selection');
        visible = await observe(state.localHouse, zFactor);
        infantry = visible.objects.find((object) => object.uid === pair.infantry.uid && object.inView);
        if (!infantry) throw new Error('Infantry left exposed local-visible view before selection');
        await at(infantry.pixel);
        await click(infantry.pixel.x, infantry.pixel.y, 'quick', 'left', 80);
        const selectUntil = Math.min(deadline, performance.now() + 3000);
        do {
          state = await command();
          const selected = state.objects.filter((object) => object.owner === state.localHouse && object.selected);
          if (
            selected.length === 1 &&
            selected[0].uid === infantry.uid &&
            (selected[0].kind === 'infantry' || (combatUnits && selected[0].kind === 'vehicle'))
          ) {
            attempt.selection = { frame: state.frame, object: commandObject(selected[0]), point: infantry.pixel };
            break;
          }
          await sleep(100);
        } while (performance.now() < selectUntil);
        if (!attempt.selection) throw new Error('Actual native single-infantry UID selection was not observed');
        visible = await observe(state.localHouse, zFactor);
        building = visible.objects.find((object) => object.uid === pair.building.uid && object.inView);
        if (!building) throw new Error('Enemy building is no longer high-health, local-visible and exposed');
        state = await command();
        const selected = state.objects.filter((object) => object.owner === state.localHouse && object.selected);
        const target = state.objects.find((object) => object.uid === building.uid);
        if (
          selected.length !== 1 ||
          selected[0].uid !== infantry.uid ||
          !target ||
          target.owner !== building.owner ||
          target.health < 0.7
        )
          throw new Error('Actual native selection/target identity changed before attack');
        attempt.before = { frame: state.frame, infantry: commandObject(selected[0]), building: commandObject(target) };
        if (
          selected[0].target?.kind === 'object' &&
          selected[0].target.uid === building.uid &&
          (selected[0].mission === 'Attack' || selected[0].queuedMission === 'Attack')
        )
          throw new Error('This infantry already attacks that building; a new click cannot prove a changed order');
        attempt.beforeScreenshot = await shot?.(`harass-${index + 1}-before`);
        visible = await observe(state.localHouse, zFactor);
        building = visible.objects?.find((object) => object.uid === pair.building.uid && object.inView);
        if (!building) throw new Error('Enemy building left visible tactical view while capturing the before picture');
        const baseline = await effects(zFactor);
        await at(building.pixel);
        await click(building.pixel.x, building.pixel.y, 'quick', 'left', 80);
        attempt.input = { button: 'left', modifiers: [], point: building.pixel, nativeVisibleTarget: building };
        const orderUntil = Math.min(deadline, performance.now() + 8000);
        do {
          state = await command();
          const actual = state.objects.find(
            (object) => object.uid === infantry.uid && object.owner === state.localHouse,
          );
          const enemy = state.objects.find((object) => object.uid === building.uid && object.owner === building.owner);
          const sample = { frame: state.frame, infantry: commandObject(actual), building: commandObject(enemy) };
          if (attempt.samples.length < 40) attempt.samples.push(sample);
          const attack = actual?.mission === 'Attack' || actual?.queuedMission === 'Attack';
          const targetMatches = actual?.target?.kind === 'object' && actual.target.uid === building.uid;
          if (actual?.selected && actual.health > 0 && attack && targetMatches) {
            attempt.after = sample;
            attempt.verified = true;
            attempt.healthChanged = !!enemy && enemy.health < attempt.before.building.health;
            report.met = true;
            report.proof = {
              candidate: index + 1,
              selectedUid: infantry.uid,
              targetUid: building.uid,
              nativeAttackMission: actual.mission,
              nativeQueuedMission: actual.queuedMission,
              targetHealthBefore: attempt.before.building.health,
              targetHealthAfter: enemy?.health ?? null,
              continuousFight: 'Not measured by this helper; requires the separate 60-second visible combat gate',
            };
            break;
          }
          await sleep(150);
        } while (performance.now() < orderUntil);
        if (!attempt.verified)
          throw new Error('No changed native Attack order with the clicked enemy UID was observed');
        attempt.afterScreenshot = await shot?.(`harass-${index + 1}-after`);
        await firing(attempt, infantry, building, zFactor, baseline);
      } catch (error) {
        report.met = false;
        delete report.proof;
        attempt.verified = false;
        attempt.error = String(error?.stack ?? error);
      }
      await emit('combat-attack-attempt', attempt);
    }
    if (!report.met) report.error ??= 'Three bounded actual visible-enemy attacks did not establish a verified order';
  } catch (error) {
    report.met = false;
    report.error = String(error?.stack ?? error);
  } finally {
    for (const name of [...held]) {
      try {
        await page.keyboard.up(name);
        held.delete(name);
      } catch (error) {
        report.met = false;
        report.releaseError = String(error);
      }
    }
    report.finishedAtMs = performance.now();
    report.durationMs = report.finishedAtMs - started;
    await emit('combat-visible-enemy-attack', report);
  }
  return report;
}

/** Keep a real army together and focus visible enemies through ordinary player input. */
export async function fightToVictory({
  page,
  click,
  point,
  commandState,
  readBytes,
  record,
  shot,
  alliedHouses,
  inputState,
  ownerIdle,
  seconds = 600,
}) {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600)
    throw new Error('Ordinary assault duration must be in (0,600] seconds');
  if (!Array.isArray(alliedHouses)) throw new Error('Genuine native allies are required');
  const started = performance.now(),
    deadline = started + seconds * 1000;
  const report = {
    input: 'Trusted browser P, Meta+2/2, arrows and ordinary left clicks; no game-state writes',
    scouting:
      'Enemy ground observations may guide ordinary ground movement; attack clicks require current native visible shroud and an exposed tactical point',
    seconds,
    orders: [],
    snapshots: [],
    firing: [],
    effectReadErrors: [],
    ending: null,
    error: null,
    visualReviewRequired: true,
  };
  const held = new Set();
  const guard = async () => ownerIdle?.();
  const emit = async (name, proof) => record?.(name, proof);
  const key = async (name, ms = 100) => {
    await guard();
    held.add(name);
    try {
      await page.keyboard.down(name);
      await delay(ms);
    } finally {
      await page.keyboard.up(name);
      held.delete(name);
    }
    await delay(100);
  };
  const press = async (name) => {
    await guard();
    await page.keyboard.press(name, { delay: 100 });
    await delay(150);
  };
  const picture = async (label) => {
    await guard();
    const path = await shot(label);
    report.snapshots.push({ label, path, atMs: performance.now() - started });
    return path;
  };
  const ownArmy = (state) =>
    state.objects.filter(
      (object) =>
        object.owner === report.localHouse &&
        object.health > 0 &&
        object.group === 1 &&
        ['infantry', 'vehicle'].includes(object.kind),
    );
  const opponentHouses = new Set();
  const enemy = (object) =>
    object.health > 0 &&
    opponentHouses.has(object.owner) &&
    object.owner !== report.localHouse &&
    !alliedHouses.includes(object.owner) &&
    ['building', 'infantry', 'vehicle'].includes(object.kind);
  let zFactor;
  const project = (object, view) => ({
    x: Math.trunc((30 * (object.x - object.y)) / 256) - view.x,
    y:
      Math.trunc((15 * (object.x + object.y)) / 256) -
      Math.trunc(object.z * zFactor + (object.z >= 728 ? 1 : 0) + 0.5) -
      view.y,
  });
  const observe = () =>
    page.evaluate(
      ({ zFactor, localHouse, allies, visibleSource, combatSource }) => {
        const visible = (0, eval)(`(${visibleSource})`)({
          localHouse,
          allies,
          zFactor,
          minHealth: 0,
          combatUnits: true,
        });
        if (visible.error) return null;
        const state = window.__hdBridge.diagnostics.state;
        const combat = (0, eval)(`(${combatSource})`)(state, zFactor);
        return {
          ...visible,
          visible: visible.objects,
          bullets: combat.effects.filter((effect) => effect.kind === 'bullet' && effect.inView),
        };
      },
      {
        zFactor,
        localHouse: report.localHouse,
        allies: alliedHouses,
        visibleSource: visibleBattleObservation.toString(),
        combatSource: observePageCombat.toString(),
      },
    );
  const centerPointer = async (bounds) => {
    const value = await point((bounds.left + bounds.right) / 2, bounds.bottom / 2);
    await guard();
    await page.mouse.move(...(Array.isArray(value) ? value : [value.x, value.y]));
  };
  const pan = async (ground) => {
    for (let i = 0; i < 8 && performance.now() < deadline; i++) {
      const state = await commandState(),
        scene = await observe();
      if (!state?.view || !scene) return false;
      const pixel = project(ground, state.view),
        bounds = scene.bounds;
      if (pixel.x >= bounds.left + 80 && pixel.x < bounds.right - 80 && pixel.y >= 80 && pixel.y < bounds.bottom - 80)
        return true;
      await centerPointer(bounds);
      const dx = pixel.x - (bounds.left + bounds.right) / 2,
        dy = pixel.y - bounds.bottom / 2;
      const horizontal = Math.abs(dx) >= Math.abs(dy),
        delta = horizontal ? dx : dy;
      await key(
        horizontal ? (delta > 0 ? 'ArrowRight' : 'ArrowLeft') : delta > 0 ? 'ArrowDown' : 'ArrowUp',
        Math.min(700, Math.max(100, Math.abs(delta) * 0.45)),
      );
      const next = await commandState();
      if (next?.view?.x === state.view.x && next?.view?.y === state.view.y) return false;
    }
    return false;
  };
  const exposedClick = async (pixel) => {
    const value = await point(Math.round(pixel.x), Math.round(pixel.y));
    const browser = Array.isArray(value) ? { x: value[0], y: value[1] } : value;
    if (
      !(await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y) === document.querySelector('#screen'),
        browser,
      ))
    )
      throw new Error('Browser controls cover the intended assault click');
    await guard();
    await click(pixel.x, pixel.y, 'quick', 'left');
  };
  const outcomes = async () => {
    const vector = Buffer.from(await readBytes(0xa80228, 20));
    const count = vector.readInt32LE(16),
      list = vector.readUInt32LE(4);
    if (count < 2 || count > 32 || list < 0x10000) throw new Error('Invalid native house observations');
    const pointers = Buffer.from(await readBytes(list, count * 4)),
      houses = [];
    for (let index = 0; index < Math.min(count, 6); index++) {
      const pointer = pointers.readUInt32LE(index * 4);
      const defeated = Buffer.from(await readBytes(pointer + 0x1f5, 1))[0];
      const type = Buffer.from(await readBytes(pointer + 0x34, 4)).readUInt32LE();
      if (type < 0x10000) throw new Error('Invalid native country observation');
      const country = Buffer.from(await readBytes(type + 0x24, 24))
        .toString('ascii')
        .split('\0')[0];
      // Neutral and Special houses own scenery; they are not skirmish opponents.
      const player = country !== 'Neutral' && country !== 'Special';
      houses.push({ index, country, player, defeated: defeated === 1, originalDefeatedByte: defeated });
    }
    return houses;
  };
  const ending = async (trigger, houses = null) => {
    const captures = [];
    // Capture first, before slower read-only metadata. The original victory
    // overlay may disappear before the score controls become enumerable.
    for (let index = 0; index < 16; index++) {
      const screenshot = await picture(`assault-ending-${String(index).padStart(2, '0')}`);
      if (!houses) houses = await outcomes();
      const ui = await inputState();
      captures.push({
        screenshot,
        modal: ui.modal,
        controls: ui.controls.filter((control) => control.visible && control.enabled),
      });
      await delay(250);
    }
    report.ending = {
      trigger,
      houses,
      captures,
      interpretation:
        'Actual transient pictures and native UI only; review for the victory message, score text and outcome. House flags alone do not establish a victory screen.',
    };
    await emit('assault-ending', report.ending);
  };
  try {
    await guard();
    const ui = await inputState(),
      initial = await commandState();
    if (ui.modal || !initial?.view || initial.localHouse < 0 || initial.localHouse > 5)
      throw new Error('Resume a genuine running battle before assault');
    await delay(250);
    const advanced = await commandState();
    if (advanced.frame <= initial.frame) throw new Error('Original game logic is not advancing');
    report.localHouse = initial.localHouse;
    for (const house of await outcomes()) {
      if (house.player && house.index !== report.localHouse && !alliedHouses.includes(house.index))
        opponentHouses.add(house.index);
    }
    if (!opponentHouses.size) throw new Error('No genuine skirmish opponents were observed');
    report.running = { beforeFrame: initial.frame, afterFrame: advanced.frame, modal: ui.modal };
    zFactor = Buffer.from(await readBytes(0xb0cd48, 8)).readDoubleLE();
    if (!Number.isFinite(zFactor) || zFactor <= 0 || zFactor > 4) throw new Error('Invalid native projection');
    const scene = await observe();
    if (!scene) throw new Error('Current visible HD state is required');
    await centerPointer(scene.bounds);
    await click((scene.bounds.left + scene.bounds.right) / 2, scene.bounds.bottom / 2, 'quick', 'right');
    await press('p');
    await press('Meta+2');
    const selected = await commandState();
    report.army = ownArmy(selected).map(commandObject);
    if (!report.army.length || !report.army.some((object) => object.selected))
      throw new Error('Ordinary P/Meta+2 did not create the selected army');
    await picture('assault-start');
    let targetUid = null,
      lastOrderAt = 0,
      nextSnapshotAt = performance.now() + 30000,
      lastScoutingAt = 0;
    const seenBullets = new Set(),
      photographedTargets = new Set();
    while (performance.now() < deadline) {
      await guard();
      const state = await commandState(),
        nativeUi = await inputState();
      if (nativeUi.modal || !state?.view) {
        await ending('native ending/dialog transition');
        break;
      }
      const houses = await outcomes();
      const enemies = houses.filter((house) => opponentHouses.has(house.index));
      if (enemies.length && enemies.every((house) => house.defeated)) {
        await ending('All genuine enemy HouseClass::Defeated flags became true', houses);
        break;
      }
      const army = ownArmy(state);
      if (!army.length) throw new Error('The ordinary assault army was eliminated');
      if (state.sidebar?.modes?.repair || state.sidebar?.modes?.sell) throw new Error('Repair/sell mode is armed');
      const current = await observe();
      if (!current) {
        await delay(150);
        continue;
      }
      const visibleEnemies = current.visible.filter((object) => enemy(object) && object.inView);
      const centroid = {
        x: army.reduce((sum, object) => sum + object.x, 0) / army.length,
        y: army.reduce((sum, object) => sum + object.y, 0) / army.length,
      };
      const candidates = state.objects
        .filter(enemy)
        .sort(
          (a, b) => Math.hypot(a.x - centroid.x, a.y - centroid.y) - Math.hypot(b.x - centroid.x, b.y - centroid.y),
        );
      const target =
        visibleEnemies.find((object) => object.uid === targetUid) ??
        visibleEnemies.find((object) => object.kind === 'building') ??
        visibleEnemies[0];
      if (target && (target.uid !== targetUid || performance.now() - lastOrderAt > 8000)) {
        await press('2');
        const fresh = await observe(),
          actual = fresh?.visible.find((object) => object.uid === target.uid && object.inView);
        if (actual && enemy(actual)) {
          const before = await commandState();
          await exposedClick(actual.pixel);
          await delay(150);
          const after = await commandState();
          const order = {
            frame: after.frame,
            target: actual,
            before: ownArmy(before).map(commandObject),
            after: ownArmy(after).map(commandObject),
            input: 'Plain left click on currently visible non-allied object',
            nativeAttackAccepted: ownArmy(after).some(
              (object) =>
                object.selected &&
                (object.mission === 'Attack' || object.queuedMission === 'Attack') &&
                object.target?.kind === 'object' &&
                object.target.uid === actual.uid,
            ),
          };
          report.orders.push(order);
          await emit('assault-attack-order', order);
          targetUid = actual.uid;
          lastOrderAt = performance.now();
        }
      } else if (!target && candidates.length && performance.now() - lastScoutingAt > 4000) {
        const ground = candidates[0];
        if (await pan(ground)) {
          const afterPan = await observe(),
            revealed = afterPan?.visible.find((object) => object.uid === ground.uid && object.inView);
          await press('2');
          // A revealed enemy will be handled as an attack on the next iteration.
          // Otherwise click a nearby ground point, never the hidden object itself.
          if (!revealed && afterPan) {
            const latest = await commandState();
            const location = { ...ground, x: ground.x + 2 * 256 };
            const pixel = project(location, latest.view),
              b = afterPan.bounds;
            if (pixel.x > b.left + 40 && pixel.x < b.right - 40 && pixel.y > 40 && pixel.y < b.bottom - 40) {
              await exposedClick(pixel);
              await emit('assault-scout-ground', {
                frame: latest.frame,
                ground: location,
                point: pixel,
                input: 'Plain ground Move toward enemy ground; not an attack on an unseen enemy',
              });
            }
          }
        }
        lastScoutingAt = performance.now();
      }
      const firingScene = await observe();
      for (const bullet of firingScene?.bullets ?? []) {
        try {
          const identity = `${bullet.id}:${bullet.uid}`;
          if (seenBullets.has(identity)) continue;
          seenBullets.add(identity);
          const raw = Buffer.from(await readBytes(bullet.id, 0x110));
          if (raw.readUInt32LE(0x10) !== bullet.uid) continue;
          const firer = raw.readUInt32LE(0xb0);
          const targetPointer = raw.readUInt32LE(0x10c);
          if (firer < 0x10000 || targetPointer < 0x10000) continue;
          const firerUid = Buffer.from(await readBytes(firer + 0x10, 4)).readUInt32LE();
          const targetUid = Buffer.from(await readBytes(targetPointer + 0x10, 4)).readUInt32LE();
          if (Buffer.from(await readBytes(bullet.id + 0x10, 4)).readUInt32LE() !== bullet.uid) continue;
          const freshState = await commandState(),
            unit = ownArmy(freshState).find((object) => object.uid === firerUid);
          const freshScene = await observe();
          const visibleUnit = freshScene?.visible.find((object) => object.uid === firerUid && object.inView);
          const visibleTarget =
            unit?.target?.kind === 'object' &&
            freshScene?.visible.find(
              (object) => object.uid === targetUid && object.uid === unit.target.uid && object.inView && enemy(object),
            );
          if (!unit || !visibleUnit || !visibleTarget || photographedTargets.has(visibleTarget.uid)) continue;
          const screenshot = await picture(`assault-firing-${report.firing.length + 1}`);
          const proof = {
            screenshot,
            bullet,
            nativeFirer: { pointer: firer, uid: firerUid },
            nativeTarget: { pointer: targetPointer, uid: targetUid },
            unit: commandObject(unit),
            visibleUnit,
            visibleTarget,
            frame: freshState.frame,
          };
          report.firing.push(proof);
          photographedTargets.add(visibleTarget.uid);
          await emit('assault-visible-firing', proof);
        } catch (error) {
          const proof = { bullet: { id: bullet.id, uid: bullet.uid }, error: String(error) };
          report.effectReadErrors.push(proof);
          await emit('assault-effect-read-error', proof);
        }
      }
      if (performance.now() >= nextSnapshotAt) {
        await picture(`assault-progress-${report.snapshots.length}`);
        await emit('assault-progress', { frame: state.frame, army: army.map(commandObject), houses });
        nextSnapshotAt = performance.now() + 30000;
      }
      await delay(150);
    }
    if (!report.ending) report.error = 'Bounded ordinary assault ended before a genuine ending was captured';
  } catch (error) {
    report.error = String(error?.stack ?? error);
    await picture('assault-failure').catch(() => {});
  } finally {
    for (const name of held) await page.keyboard.up(name).catch(() => {});
    report.durationMs = performance.now() - started;
    await emit('ordinary-fight-to-victory', report);
  }
  return report;
}
