import { setTimeout as delay } from 'node:timers/promises';
import { observePageCombat } from './page-battle-input.mjs';

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
}) {
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
    return page.evaluate(
      ({ localHouse, allies, zFactor, minHealth, combatUnits }) => {
        const diagnostics = window.__hdBridge?.diagnostics;
        const state = diagnostics?.state;
        if (!diagnostics?.enabled || !diagnostics?.shown || !state?.view || !state.shroud || !state.sidebar)
          return { error: 'Actual visible HD battle state, native shroud or sidebar is unavailable' };
        if (performance.now() - diagnostics.counters.lastStateAtMs > 500)
          return { error: 'Native render state is stale' };
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
      },
      { localHouse, allies: alliedHouses, zFactor, minHealth, combatUnits },
    );
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
