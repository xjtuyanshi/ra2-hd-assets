import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPhase7EvidenceStream } from './phase7-input-stream.mjs';

/** Read-only long-match measurements, independent of the caller's input loop.
 * Existing bridge counters count every real arrival/draw; the one-second disk
 * sample does not limit those measurements to one state or frame per second.
 * Stop before leaving the match. This owns only its observer and evidence file.
 */
export async function startPhase10MatchRates({
  page,
  out,
  record,
  label = 'match-rates',
  readNativeLogicEndpoint,
  readNativeCadenceEndpoint,
  externallyDismissedDialogs = false,
}) {
  assert(/^[a-zA-Z0-9_-]+$/.test(label), 'Simple evidence label required');
  const evidence = await createPhase7EvidenceStream(join(out, `${label}.ndjson`));
  // Observer cleanup must still return if a JavaScript dialog blocks the page.
  // These are operation timeouts, not additional match acceptance thresholds.
  const bounded = async (operation, stage, timeoutMs = 10_000) => {
    let timeout;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`${stage} timed out`)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
  const evaluate = (fn, args) => bounded(page.evaluate(fn, args), 'Rate observer page evaluation');
  const problemSlot = '__phase10MatchProblemObserver';
  const cancelledSlot = '__phase10MatchCancelledOwners';
  const problemOwner = randomUUID();
  const bootstrapExpiresAt = Date.now() + 10_000;
  let removeListeners = async () => {};
  let observerCleanupPromise;
  const stopProblemObserver = () =>
    evaluate(
      ({ slot, cancelledSlot, owner }) => {
        const cancelled = (window[cancelledSlot] ??= new Set());
        cancelled.add(owner);
        const probe = window[slot];
        if (probe?.owner !== owner)
          return { cleanup: { ownerCancelled: true, ownedObserverAbsent: true, otherOwnerPreserved: !!probe } };
        let result;
        let cleanupError = null;
        try {
          probe.inspect('final');
          result = probe.snapshot(true);
        } catch (error) {
          cleanupError = String(error);
        } finally {
          probe.dispose();
        }
        return {
          ...result,
          cleanupError,
          cleanup: { ownerCancelled: true, ownedObserverAbsent: window[slot]?.owner !== owner },
        };
      },
      { slot: problemSlot, cancelledSlot, owner: problemOwner },
    );
  const cleanupObservers = () => {
    if (observerCleanupPromise) return observerCleanupPromise;
    return (observerCleanupPromise = (async () => {
      await removeListeners();
      try {
        return await stopProblemObserver();
      } catch (error) {
        return {
          cleanupError: String(error),
          cleanup: { ownerCancelled: 'UNVERIFIED', ownedObserverAbsent: 'UNVERIFIED' },
        };
      }
    })());
  };
  try {
    await evaluate(
      ({ slot, cancelledSlot, owner, bootstrapExpiresAt }) => {
        const cancelled = (window[cancelledSlot] ??= new Set());
        if (Date.now() >= bootstrapExpiresAt || cancelled.has(owner))
          throw new Error('Application problem observer initialization expired or cancelled');
        if (window[slot]) throw new Error('Application problem observer already owned');
        const root = document.querySelector('#ui');
        if (!root) throw new Error('The actual application main region is missing');
        // page.ts showProblemPanel -> mainPanel -> RuntimePanels.ProblemPanel.
        // Observe only its React region, not the high-frequency cursor styles.
        const selector = 'section.panel.game-folder-panel.bad-page';
        const probe = {
          owner,
          selector,
          startedAtMs: performance.now(),
          current: null,
          everPresent: false,
          everVisible: false,
          panelAppearances: 0,
          changes: 0,
          mutationBatches: 0,
          omittedEvents: 0,
          events: [],
          signature: 'null',
          disposed: false,
          expiresAt: Date.now() + 10_000,
        };
        probe.dispose = () => {
          probe.disposed = true;
          cancelled.add(owner);
          clearTimeout(probe.expiryTimer);
          probe.observer?.disconnect();
          if (window[slot]?.owner === owner) delete window[slot];
        };
        probe.active = () =>
          !probe.disposed && window[slot]?.owner === owner && !cancelled.has(owner) && Date.now() < probe.expiresAt;
        const expire = () => {
          if (probe.disposed) return;
          const remaining = probe.expiresAt - Date.now();
          if (remaining <= 0) probe.dispose();
          else probe.expiryTimer = setTimeout(expire, remaining);
        };
        probe.inspect = (reason) => {
          const panel = root.querySelector(selector);
          const style = panel ? getComputedStyle(panel) : null;
          const current = panel
            ? {
                visible: !!panel.getClientRects().length && style.visibility !== 'hidden' && style.display !== 'none',
                title: panel.querySelector('h3')?.textContent?.trim().slice(0, 256) ?? '',
                detail: panel.querySelector('pre')?.textContent?.trim().slice(0, 4096) ?? '',
              }
            : null;
          if (current && !probe.current) probe.panelAppearances++;
          probe.everPresent ||= current !== null;
          probe.everVisible ||= current?.visible === true;
          const signature = JSON.stringify(current);
          if (signature !== probe.signature) {
            probe.changes++;
            const event = { atMs: performance.now(), reason, panel: current };
            if (probe.events.length < 64) probe.events.push(event);
            else probe.omittedEvents++;
            probe.signature = signature;
          }
          probe.current = current;
        };
        probe.snapshot = (drain) => {
          const result = {
            source: 'MutationObserver on #ui; actual RuntimePanels.ProblemPanel selector and visible DOM',
            selector: probe.selector,
            startedAtMs: probe.startedAtMs,
            current: probe.current,
            everPresent: probe.everPresent,
            everVisible: probe.everVisible,
            panelAppearances: probe.panelAppearances,
            changes: probe.changes,
            mutationBatches: probe.mutationBatches,
            omittedEvents: probe.omittedEvents,
            events: [...probe.events],
          };
          if (drain) probe.events.length = 0;
          return result;
        };
        probe.observer = new MutationObserver(() => {
          if (!probe.active()) {
            probe.dispose();
            return;
          }
          probe.mutationBatches++;
          probe.inspect('mutation');
        });
        // Publish ownership before any operation that can fail. Expiration
        // also retires an installed observer whose reply arrives too late.
        window[slot] = probe;
        probe.expiryTimer = setTimeout(expire, 10_000);
        probe.observer.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
        });
        probe.inspect('initial');
        if (Date.now() >= bootstrapExpiresAt || cancelled.has(owner)) {
          probe.dispose();
          throw new Error('Application problem observer initialization expired or cancelled');
        }
      },
      { slot: problemSlot, cancelledSlot, owner: problemOwner, bootstrapExpiresAt },
    );
  } catch (error) {
    const cleanup = await cleanupObservers();
    await evidence.append({ kind: 'problem-observer-setup-failure', error: String(error), cleanup });
    await evidence.close();
    throw error;
  }
  const pageErrors = [];
  const dialogs = [];
  const errors = [];
  let pageErrorCount = 0;
  let dialogCount = 0;
  let readErrorCount = 0;
  let dialogDismissFailureCount = 0;
  const pendingDialogDismissals = new Set();
  const onError = (error) => {
    pageErrorCount++;
    if (pageErrors.length < 64) pageErrors.push({ at: new Date().toISOString(), error: String(error) });
  };
  const onDialog = (dialog) => {
    dialogCount++;
    const entry = {
      at: new Date().toISOString(),
      type: dialog.type(),
      message: dialog.message(),
      dismissal: 'pending',
    };
    if (dialogs.length < 64) dialogs.push(entry);
    if (externallyDismissedDialogs) {
      entry.dismissal = 'Owned by whole-session harness dialog observer';
      return;
    }
    // Adding this listener disables Playwright's default dismissal. Preserve
    // it after recording the failure; never accept a confirm or prompt.
    const pending = bounded(
      Promise.resolve().then(() => dialog.dismiss()),
      'JavaScript dialog dismissal',
      5000,
    )
      .then(() => {
        entry.dismissal = 'dismissed';
      })
      .catch((error) => {
        dialogDismissFailureCount++;
        entry.dismissal = 'failed';
        entry.dismissError = String(error);
        if (errors.length < 64) errors.push(`JavaScript dialog dismissal: ${String(error)}`);
      })
      .finally(() => pendingDialogDismissals.delete(pending));
    pendingDialogDismissals.add(pending);
  };
  page.on('pageerror', onError);
  page.on('dialog', onDialog);
  removeListeners = async () => {
    page.off('pageerror', onError);
    page.off('dialog', onDialog);
    await Promise.all([...pendingDialogDismissals]);
  };
  const read = async () => {
    const observed = await evaluate(
      async ({ slot, owner }) => {
        const probe = window[slot];
        if (probe?.owner !== owner || !probe.active())
          throw new Error('Application problem observer expired or ownership lost');
        probe.expiresAt = Date.now() + 10_000;
        const bridge = window.__hdBridge;
        const diagnostic = bridge?.diagnostics;
        if (!diagnostic) throw new Error('The current page has no real HD bridge diagnostics');
        const snapshot = {
          atMs: performance.now(),
          timeOrigin: performance.timeOrigin,
          clockContext: 'page',
          counters: diagnostic.counters,
          enabled: diagnostic.enabled,
          shown: diagnostic.shown,
          visibility: document.visibilityState,
          discreteInput: window.__phase7InputProbe?.discrete ?? null,
          inputLifecycle: window.__phase7InputProbe?.lifecycle ?? null,
          viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
          timeline: bridge.timeline,
        };
        const game = await diagnostic.getGamePerformance();
        if (window[slot]?.owner !== owner || !probe.active())
          throw new Error('Application problem observer expired or ownership lost');
        probe.inspect('sample');
        return { ...snapshot, game, applicationProblemPanel: probe.snapshot(true) };
      },
      { slot: problemSlot, owner: problemOwner },
    );
    const nativeLogic = readNativeLogicEndpoint
      ? await bounded(readNativeLogicEndpoint(), 'Direct native logic endpoint')
      : null;
    const nativeCadence = readNativeCadenceEndpoint
      ? await bounded(readNativeCadenceEndpoint(), 'Native cadence endpoint')
      : null;
    return { ...observed, nativeLogic, ...(nativeCadence ? { nativeCadence } : {}) };
  };
  let first;
  let last;
  let samples = 0;
  let mapsChanged = 0;
  let countersReset = false;
  let gameFrameReset = false;
  let nativeLogicFreshAtAllSamples = true;
  let hdShownAtAllSamples = true;
  let pageVisibleAtAllSamples = true;
  let ownerSizeAtAllSamples = true;
  let speedSettingsChanged = false;
  let stopped = false;
  let observerFailed = false;
  let stopPromise;
  const inputWindow = {
    binding: 'UNVERIFIED',
    completed: false,
    label: null,
    rate: null,
    start: null,
    end: null,
    activeSegments: [],
    ownerWaits: [],
    ownerHoldInterrupted: false,
  };
  let activeStart = null;
  let pendingWait = null;
  let sampleTail = Promise.resolve();
  let wake;
  const stopRequested = new Promise((resolve) => {
    wake = resolve;
  });
  const sampleNow = async () => {
    const observed = await read();
    await evidence.append({ kind: 'real-match-cumulative-counters', at: new Date().toISOString(), ...observed });
    if (last) {
      if (observed.counters.lastStateMap !== last.counters.lastStateMap) mapsChanged++;
      countersReset ||= ['distinctStates', 'drawnFrames', 'shownFrames'].some(
        (key) => observed.counters[key] < last.counters[key],
      );
      if (Number.isFinite(observed.nativeLogic?.frame) && Number.isFinite(last.nativeLogic?.frame))
        gameFrameReset ||= observed.nativeLogic.frame < last.nativeLogic.frame;
      if (observed.game && first.game)
        speedSettingsChanged ||= ['gameSpeed', 'sessionSpeed', 'targetFps'].some(
          (key) => observed.game[key] !== first.game[key],
        );
    }
    first ??= observed;
    last = observed;
    samples++;
    nativeLogicFreshAtAllSamples &&=
      observed.nativeLogic?.fresh === true &&
      Number.isFinite(observed.nativeLogic.frame) &&
      Number.isFinite(observed.nativeLogic.atMs);
    hdShownAtAllSamples &&= observed.shown === true;
    pageVisibleAtAllSamples &&= observed.visibility === 'visible';
    ownerSizeAtAllSamples &&=
      observed.viewport.width === 1728 && observed.viewport.height === 1117 && observed.viewport.dpr === 2;
    return observed;
  };
  const sample = () => {
    const pending = sampleTail.then(sampleNow);
    sampleTail = pending.catch(() => {});
    return pending;
  };
  const closeActiveSegment = (end) => {
    if (!activeStart) return;
    inputWindow.activeSegments.push({ start: activeStart, end });
    activeStart = null;
  };
  try {
    await sample();
  } catch (error) {
    const cleanup = await cleanupObservers();
    await evidence.append({ kind: 'rate-observer-setup-failure', error: String(error), cleanup });
    await evidence.close();
    throw error;
  }
  const observing = (async () => {
    while (!stopped) {
      await Promise.race([delay(1000), stopRequested]);
      if (stopped) break;
      try {
        await sample();
      } catch (error) {
        observerFailed = true;
        stopped = true;
        wake();
        readErrorCount++;
        if (errors.length < 64) errors.push(String(error));
        await evidence.append({
          kind: 'rate-observer-read-failure',
          at: new Date().toISOString(),
          error: String(error),
          cleanup: await cleanupObservers(),
        });
      }
    }
  })();
  return {
    // The caller may inspect this without another native read or input action.
    latest: () => last,
    inputCheckpoint: async (stage, detail) => {
      if (stopped) throw new Error('Cannot bind input to a stopped rate observer');
      if (stage === 'result') {
        inputWindow.completed = detail.completed === true;
        inputWindow.result = detail;
        await evidence.append({ kind: 'rate-input-result', detail });
        return;
      }
      const endpoint = await sample();
      await evidence.append({ kind: 'rate-input-checkpoint', stage, detail, endpoint });
      if (stage === 'start') {
        if (inputWindow.start) throw new Error('Input window already started');
        inputWindow.label = detail.label;
        inputWindow.rate = detail.rate;
        inputWindow.start = endpoint;
        activeStart = endpoint;
      } else if (stage === 'wait-start') {
        if (!activeStart || pendingWait) throw new Error('Input wait checkpoint is out of order');
        pendingWait = { start: endpoint, detail };
      } else if (stage === 'wait-end') {
        if (!pendingWait) throw new Error('Input wait end has no start');
        const wait = { ...pendingWait, end: endpoint, detail };
        inputWindow.ownerWaits.push(wait);
        // A fast idle check does not interrupt the input window. A genuine
        // owner hold (or unknown outcome) cannot count as continuous input.
        if (detail.ownerHeld !== false) {
          closeActiveSegment(pendingWait.start);
          activeStart = endpoint;
          inputWindow.ownerHoldInterrupted = true;
        }
        pendingWait = null;
      } else if (stage === 'end') {
        if (!inputWindow.start || inputWindow.end || pendingWait)
          throw new Error('Input end checkpoint is out of order');
        closeActiveSegment(endpoint);
        inputWindow.end = endpoint;
        inputWindow.completed = detail.completed === true;
        inputWindow.binding = 'Same page input start/end and owner-wait endpoints sampled before input cleanup';
      } else throw new Error(`Unknown input checkpoint: ${stage}`);
    },
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      wake();
      return (stopPromise = (async () => {
        try {
          await observing;
        } catch (error) {
          readErrorCount++;
          if (errors.length < 64) errors.push(String(error));
        }
        let applicationProblemPanel;
        try {
          if (!observerFailed) await sample();
        } catch (error) {
          readErrorCount++;
          if (errors.length < 64) errors.push(String(error));
          await evidence.append({ kind: 'rate-observer-final-read-failure', error: String(error) });
        } finally {
          applicationProblemPanel = await cleanupObservers();
        }
        if (applicationProblemPanel.cleanupError) {
          readErrorCount++;
          if (errors.length < 64) errors.push(applicationProblemPanel.cleanupError);
        }
        const observationSeconds = (last.atMs - first.atMs) / 1000;
        const segments = inputWindow.activeSegments;
        const inputBound = inputWindow.start !== null && inputWindow.end !== null && pendingWait === null;
        const seconds = inputBound ? segments.reduce((sum, s) => sum + (s.end.atMs - s.start.atMs) / 1000, 0) : null;
        const uninterruptedInputSeconds = inputBound
          ? Math.max(0, ...segments.map((s) => (s.end.atMs - s.start.atMs) / 1000))
          : null;
        const countDelta = (key) =>
          inputBound ? segments.reduce((sum, s) => sum + s.end.counters[key] - s.start.counters[key], 0) : null;
        const logicMs = inputBound
          ? segments.reduce((sum, s) => sum + (s.end.nativeLogic?.atMs - s.start.nativeLogic?.atMs), 0)
          : null;
        const logicFrames = inputBound
          ? segments.reduce((sum, s) => sum + (s.end.nativeLogic?.frame - s.start.nativeLogic?.frame), 0)
          : null;
        const logicPerSecond =
          nativeLogicFreshAtAllSamples && !gameFrameReset && logicMs > 0 && logicFrames >= 0
            ? (logicFrames * 1000) / logicMs
            : null;
        const shownPerSecond = !countersReset && seconds > 0 ? countDelta('shownFrames') / seconds : null;
        const statesPerSecond = !countersReset && seconds > 0 ? countDelta('distinctStates') / seconds : null;
        const drawnPerSecond = !countersReset && seconds > 0 ? countDelta('drawnFrames') / seconds : null;
        const result = {
          source:
            'Existing HD bridge cumulative distinct-state/completed-draw counters; direct read-only native frame/time endpoints',
          scope:
            'Rates are bound to the same page input checkpoints; base building, fighting and match identity still require separate current-run evidence',
          observationSeconds,
          seconds,
          uninterruptedInputSeconds,
          durationAtLeastTenMinutes: inputBound && inputWindow.completed && uninterruptedInputSeconds >= 600,
          inputWindow,
          samples,
          first,
          last,
          mapsChanged,
          countersReset,
          gameFrameReset,
          nativeLogicFreshAtAllSamples,
          speedSettingsChanged,
          hdShownAtAllSamples,
          pageVisibleAtAllSamples,
          ownerSizeAtAllSamples,
          logicFrames,
          logicMs,
          logicPerSecond,
          distinctStates: countDelta('distinctStates'),
          shownFrames: countDelta('shownFrames'),
          drawnFrames: countDelta('drawnFrames'),
          statesPerSecond,
          shownPerSecond,
          drawnPerSecond,
          pageErrors,
          pageErrorCount,
          dialogs,
          dialogCount,
          dialogDismissFailureCount,
          pendingDialogDismissalsAtEnd: pendingDialogDismissals.size,
          errors,
          readErrorCount,
          applicationProblemPanel,
          noObservedErrors:
            pageErrorCount === 0 &&
            dialogCount === 0 &&
            readErrorCount === 0 &&
            applicationProblemPanel?.everPresent === false &&
            applicationProblemPanel?.omittedEvents === 0,
          rateTargetsMet:
            inputBound &&
            inputWindow.completed &&
            !mapsChanged &&
            !countersReset &&
            !gameFrameReset &&
            nativeLogicFreshAtAllSamples &&
            !speedSettingsChanged &&
            ownerSizeAtAllSamples &&
            pageVisibleAtAllSamples &&
            hdShownAtAllSamples &&
            !observerFailed &&
            readErrorCount === 0 &&
            logicPerSecond !== null &&
            logicPerSecond >= 62 &&
            shownPerSecond >= 55 &&
            statesPerSecond >= 50,
          observationLimitation:
            'One-second visibility/configuration samples do not prove unseen intervals. Cumulative arrival/draw counts include every intervening bridge event, not only these samples. Native frame endpoints measure game logic independently of HD draws.',
        };
        await evidence.append({ kind: 'real-match-rate-summary', ...result });
        result.artifact = await evidence.close();
        await record?.('real-match-rates', result);
        return result;
      })());
    },
  };
}
