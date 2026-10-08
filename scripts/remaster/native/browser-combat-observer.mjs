import { randomUUID } from 'node:crypto';

// A lingering or returning muzzle is not another shot. Prime with all current
// native IDs (including offscreen ones); retain only first sightings thereafter.
export function retainFreshCombat(observation, seenMuzzles) {
  const effects = observation.effects.filter(
    (effect) => effect.kind !== 'muzzle' || !seenMuzzles.has(`${effect.id}:${effect.uid}`),
  );
  let muzzleHistoryTruncated = false;
  for (const key of observation.muzzleKeys ?? []) {
    if (seenMuzzles.has(key)) continue;
    if (seenMuzzles.size < 20000) seenMuzzles.add(key);
    else muzzleHistoryTruncated = true;
  }
  return {
    ...observation,
    effects,
    muzzleHistoryTruncated,
    visible: effects.length,
    inView: effects.filter((effect) => effect.inView).length,
  };
}

// Observe delivered states in the page instead of sampling short-lived weapons
// through a slow Playwright round trip. This owns only its callback and records.
export async function startBrowserCombatObserver(page, source, zFactor) {
  const slot = '__nativeBrowserCombatObserver';
  const owner = randomUUID();
  await page.evaluate(
    ({ slot, owner, source, freshSource, zFactor }) => {
      if (window[slot]) throw new Error('Combat observer already owned');
      const observe = Function(`return (${source})`)();
      const diagnostic = window.__hdBridge.diagnostics;
      const fresh = Function(`return (${freshSource})`)();
      const initial = observe(diagnostic.combatState, zFactor);
      const seenMuzzles = new Set(initial.muzzleKeys ?? []);
      const capture = diagnostic.startCapture();
      const observer = {
        owner,
        startAtMs: capture.startAtMs,
        samples: [],
        latest: null,
        truncated: false,
        animsTruncated: initial.animsTruncated === true,
        raf: null,
        lastFrame: capture.startStateFrame,
        lastObservedAtMs: -Infinity,
        costsMs: [],
      };
      const tick = () => {
        const counters = diagnostic.counters;
        const now = performance.now();
        // Combat evidence is a bounded 20 Hz observation, not the delivery
        // measurement. The bridge independently retains every arrival/draw.
        // Avoid cloning fog/animation metadata on every render-state delivery.
        if (
          now - observer.lastObservedAtMs >= 50 &&
          counters.lastStateFrame !== null &&
          counters.lastStateFrame !== observer.lastFrame
        ) {
          observer.lastObservedAtMs = now;
          const state = diagnostic.combatState;
          const observation = fresh(observe(state, zFactor), seenMuzzles);
          if (observation.animsTruncated) observer.animsTruncated = true;
          if (observation.muzzleHistoryTruncated) observer.truncated = true;
          observer.lastFrame = counters.lastStateFrame;
          const atMs = performance.now();
          if (observer.costsMs.length < 20000) observer.costsMs.push(atMs - now);
          observer.latest = { ...observation, atMs, stateAgeMs: atMs - counters.lastStateAtMs };
          if (observer.samples.length < 20000)
            observer.samples.push({
              atMs,
              frame: observation.frame,
              stateAgeMs: observer.latest.stateAgeMs,
              inView: observation.inView,
              effects: observation.effects.filter((effect) => effect.inView),
            });
          else observer.truncated = true;
        }
        observer.raf = requestAnimationFrame(tick);
      };
      window[slot] = observer;
      observer.raf = requestAnimationFrame(tick);
    },
    { slot, owner, source, freshSource: retainFreshCombat.toString(), zFactor },
  );
  return {
    latest: () =>
      page.evaluate(
        ({ slot, owner }) => {
          const observer = window[slot];
          if (observer?.owner !== owner) throw new Error('Combat observer ownership lost');
          return observer.latest
            ? { ...observer.latest, stateAgeMs: observer.latest.stateAgeMs + performance.now() - observer.latest.atMs }
            : null;
        },
        { slot, owner },
      ),
    stop: () =>
      page.evaluate(
        ({ slot, owner }) => {
          const observer = window[slot];
          if (observer?.owner !== owner) throw new Error('Combat observer ownership lost');
          cancelAnimationFrame(observer.raf);
          delete window[slot];
          return {
            capture: window.__hdBridge.diagnostics.finishCapture(),
            samples: observer.samples,
            truncated: observer.truncated,
            animsTruncated: observer.animsTruncated,
            startAtMs: observer.startAtMs,
            costsMs: observer.costsMs,
          };
        },
        { slot, owner },
      ),
  };
}
