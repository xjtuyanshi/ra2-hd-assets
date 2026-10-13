import assert from 'node:assert/strict';
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Disable only the inspector's copies of Worker network payloads. The actual
 * page/Worker WebSockets, input and pictures remain untouched. Chromium's
 * Network inspector otherwise copies every large binary mirror through the
 * Playwright driver even when nobody subscribes to frameReceived. This private
 * seam is deliberately checked against the installed in-process driver. */
export async function disableWorkerNetworkPayloadObservation(page) {
  const implementation = page?._connection?.toImpl?.(page);
  const sessions = implementation?.delegate?._networkManager?._sessions;
  if (!(sessions instanceof Map))
    throw new Error('Use in-process chromium.launch for bounded Worker payload observation');
  let disabled = 0;
  for (const info of sessions.values()) {
    if (!info.workerFrame || info.session._closed || info.session._crashed) continue;
    await info.session.send('Network.disable');
    disabled++;
  }
  return { disabledWorkerInspectorSessions: disabled, runtimeNetworkChanged: false };
}

export async function createPhase7EvidenceStream(path) {
  const handle = await open(path, 'wx', 0o600);
  let bytes = 0;
  let records = 0;
  let writeTail = Promise.resolve();
  return {
    async append(record) {
      // Callers await writes: disk backpressure cannot accumulate promises or
      // entire-session records in the acceptance process.
      const line = JSON.stringify(record) + '\n';
      const pending = writeTail.then(async () => {
        await handle.write(line);
        bytes += Buffer.byteLength(line);
        records++;
      });
      writeTail = pending;
      await pending;
    },
    async close() {
      try {
        await writeTail;
      } finally {
        await handle.close();
      }
      return { path, bytes, records };
    },
  };
}

/** Observe the real NativeCore Input requests and GUI-consumption replies.
 * This wrapper never submits, delays, replaces or retries a request. */
async function startPhase7NativeInputObserver(worker) {
  return worker.evaluate(() => {
    let observer = globalThis.__phase7NativeInputObserver;
    if (!observer) {
      const connection = globalThis.__auditCore?.connection;
      if (!connection) throw new Error('Audited native Input connection unavailable');
      observer = {
        active: false,
        sequence: 0,
        sequenceBeforeStart: 0,
        samples: [],
        pending: new Set(),
        started: 0,
        acknowledged: 0,
        errors: 0,
        lostEvidence: 0,
      };
      const put = (record) => {
        if (!observer.active || record.sequence <= observer.sequenceBeforeStart) return;
        if (observer.samples.length < 2048) observer.samples.push(record);
        else observer.lostEvidence++;
      };
      const original = connection.request.bind(connection);
      connection.request = function (type, payload, ...rest) {
        if (type !== 10 || payload?.byteLength !== 16) return original(type, payload, ...rest);
        const sequence = ++observer.sequence;
        const startAt = performance.timeOrigin + performance.now();
        const fields = Array.from(new Uint32Array(payload.buffer, payload.byteOffset, 4));
        const position = fields[0] === 3 || (fields[0] === 1 && fields[1] === 0x0200);
        observer.pending.add(sequence);
        if (observer.active) observer.started++;
        put({ kind: 'native-input-request', at: startAt, sequence, fields, position });
        const result = original(type, payload, ...rest);
        result.then(
          () => {
            observer.pending.delete(sequence);
            const at = performance.timeOrigin + performance.now();
            if (observer.active && sequence > observer.sequenceBeforeStart) observer.acknowledged++;
            put({
              kind: 'native-input-ack',
              at,
              sequence,
              fields,
              position,
              startAt,
              roundTripMs: at - startAt,
              source: 'Actual Native Input promise fulfilled by GUI-consumption ACK; original handler may continue',
            });
          },
          (error) => {
            observer.pending.delete(sequence);
            if (observer.active && sequence > observer.sequenceBeforeStart) observer.errors++;
            put({
              kind: 'native-input-error',
              at: performance.timeOrigin + performance.now(),
              sequence,
              fields,
              position,
              startAt,
              error: String(error),
            });
          },
        );
        return result;
      };
      globalThis.__phase7NativeInputObserver = observer;
    }
    observer.samples = [];
    observer.started = observer.acknowledged = observer.errors = observer.lostEvidence = 0;
    observer.sequenceBeforeStart = observer.sequence;
    observer.active = true;
    return { pendingBeforeStart: observer.pending.size, sequenceBeforeStart: observer.sequence };
  });
}

async function drainPhase7NativeInputObserver(worker, stop = false) {
  return worker.evaluate((stop) => {
    const observer = globalThis.__phase7NativeInputObserver;
    if (stop) observer.active = false;
    return {
      samples: observer.samples.splice(0),
      started: observer.started,
      acknowledged: observer.acknowledged,
      errors: observer.errors,
      lostEvidence: observer.lostEvidence,
      pending: observer.pending.size,
    };
  }, stop);
}

/** The route instrumentation calls .draw(args) after the actual backend draw.
 * Only compact observations and one reference to the latest delivered picture
 * are retained. No drawing, readback, guest call or synthetic DOM input occurs. */
export async function installPhase7InputProbe(page) {
  return page.evaluate(() => {
    if (window.__phase7InputProbe) return { alreadyInstalled: true };
    const at = () => performance.timeOrigin + performance.now();
    const probe = {
      counts: {},
      samples: [],
      positions: [],
      lostEvidence: 0,
      latest: null,
      currentEvent: null,
      firstAt: null,
      lastAt: null,
      cursor: null,
      cursorDraws: 0,
      cursorMatches: 0,
      lastCursorFrame: null,
    };
    probe.position = (x, y) => {
      // Optional route seam at gameInput's genuine calculated coordinate.
      // This supplies the desired position for locked input, never evidence
      // of a cursor draw; only matching the native raster provides that.
      if (!probe.currentEvent) return;
      probe.currentEvent.gameX = Math.floor(x);
      probe.currentEvent.gameY = Math.floor(y);
      probe.currentEvent.derivedPositionAt = at();
    };
    const enqueue = (record) => {
      if (probe.samples.length < 8192) probe.samples.push(record);
      else probe.lostEvidence++;
    };
    const listen = (event) => {
      const keyboard = event.type.startsWith('key');
      if (!keyboard && event.target?.id !== 'screen') return;
      const screen = document.getElementById('screen');
      if (!screen) return;
      const bounds = screen.getBoundingClientRect();
      const frame = window.__phase7Presentation?.latestFrame;
      const coalesced = event.type === 'pointermove' ? (event.getCoalescedEvents?.() ?? []) : [];
      probe.counts[event.type] = (probe.counts[event.type] ?? 0) + 1;
      probe.counts.coalescedPositions = (probe.counts.coalescedPositions ?? 0) + Math.max(0, coalesced.length - 1);
      const record = {
        kind: 'page-input',
        type: event.type,
        at: at(),
        trusted: event.isTrusted,
        x: event.clientX ?? null,
        y: event.clientY ?? null,
        gameX:
          frame && !document.pointerLockElement
            ? Math.floor(((event.clientX - bounds.x) * frame.width) / bounds.width)
            : null,
        gameY:
          frame && !document.pointerLockElement
            ? Math.floor(((event.clientY - bounds.y) * frame.height) / bounds.height)
            : null,
        button: event.button ?? null,
        buttons: event.buttons ?? null,
        code: event.code ?? null,
        deltaY: event.deltaY ?? null,
        coalesced: coalesced.length,
        pointerLocked: !!document.pointerLockElement,
      };
      probe.firstAt ??= record.at;
      probe.lastAt = record.at;
      if (event.type.startsWith('pointer') || event.type === 'wheel') {
        probe.latest = record;
        // The genuine coordinate callback runs in this event's canvas
        // listener. Later wheel/resize callbacks must not mutate an earlier
        // button record and make its coordinate evidence appear misplaced.
        probe.currentEvent = record;
        queueMicrotask(() => {
          if (probe.currentEvent === record) probe.currentEvent = null;
        });
        probe.positions.push(record);
        if (probe.positions.length > 4096) probe.positions.splice(0, probe.positions.length - 4096);
      }
      enqueue(record);
    };
    const types = ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'keyup'];
    for (const type of types) window.addEventListener(type, listen, true);
    const presentation = {
      latestFrame: null,
      latestRaster: null,
      calibrationPoint: null,
      latestPatch: null,
      draws: [],
      count: 0,
      draw(args) {
        const frame = args[0];
        if (!frame?.width || !frame?.height) return;
        const freshNativeRaster = frame !== this.latestFrame && !!frame.rgb565;
        this.latestFrame = frame;
        const drawnAt = at();
        // Client frame ownership can recycle/transfer this buffer as soon as
        // draw returns. Snapshot only the compact pixels needed by later
        // read-only diagnostics while the draw still owns valid bytes.
        if (frame.rgb565?.length === frame.width * frame.height) {
          const spacing = 8;
          const columns = Math.ceil(frame.width / spacing);
          const rows = Math.ceil(frame.height / spacing);
          const pixels = new Uint16Array(columns * rows);
          let index = 0;
          for (let y = 0; y < frame.height; y += spacing)
            for (let x = 0; x < frame.width; x += spacing) pixels[index++] = frame.rgb565[y * frame.width + x];
          this.latestRaster = { width: frame.width, height: frame.height, spacing, pixels, at: drawnAt };
          if (this.calibrationPoint) {
            const x = Math.floor(this.calibrationPoint.x);
            const y = Math.floor(this.calibrationPoint.y);
            const patch = new Uint16Array(64 * 64);
            const valid = new Uint8Array(64 * 64);
            for (let dy = -16; dy < 48; dy++)
              for (let dx = -16; dx < 48; dx++) {
                const index = (dy + 16) * 64 + dx + 16;
                if (x + dx < 0 || x + dx >= frame.width || y + dy < 0 || y + dy >= frame.height) continue;
                patch[index] = frame.rgb565[(y + dy) * frame.width + x + dx];
                valid[index] = 1;
              }
            this.latestPatch = { x, y, pixels: patch, valid, at: drawnAt };
          }
        }
        const cursorFrame = args[4] ?? frame;
        const cursor = cursorFrame.cursor;
        const cursorPresentation = args[3];
        const record = {
          kind: 'native-picture-draw',
          at: drawnAt,
          width: frame.width,
          height: frame.height,
          nativeRgb565: !!frame.rgb565,
          freshNativeRaster,
          cursorTemplateTested: false,
          cursorMatched: false,
          separateCursor: !!cursor?.rgba?.length && cursorPresentation?.visible !== false,
          cursorX: cursor ? (cursorPresentation?.x ?? cursor.x) : null,
          cursorY: cursor ? (cursorPresentation?.y ?? cursor.y) : null,
        };
        this.count++;
        this.draws.push(record);
        if (this.draws.length > 512) this.draws.shift();
        const click = this.menuClick;
        const menuTemplate = this.menuRasterTemplate;
        let templateRaster = null;
        if (menuTemplate && frame.rgb565) {
          const dimensionsMatch = frame.width === menuTemplate.width && frame.height === menuTemplate.height;
          const roiSamples = menuTemplate.samples.map(([x, y]) =>
            x < frame.width && y < frame.height ? frame.rgb565[y * frame.width + x] : null,
          );
          let matchingPixels = 0;
          if (dimensionsMatch)
            for (const [x, y, colour] of menuTemplate.matchPixels)
              if (frame.rgb565[y * frame.width + x] === colour) matchingPixels++;
          templateRaster = {
            at: drawnAt,
            expectedControlId: menuTemplate.expectedControlId,
            dimensionsMatch,
            requiredPixels: menuTemplate.matchPixels.length,
            matchingPixels,
            exactMatch: dimensionsMatch && matchingPixels === menuTemplate.matchPixels.length,
            roiSamples,
          };
          // Own this compact ROI before client recycling, just as for the
          // general raster samples. Never read a retained frame later.
          this.latestMenuTemplateRaster = templateRaster;
        }
        if (click && frame.rgb565) {
          let changed = 0;
          for (const [x, y, colour] of click.baseline)
            if (x < frame.width && y < frame.height && frame.rgb565[y * frame.width + x] !== colour) changed++;
          const change = { at: drawnAt, changedSamples: changed, samples: click.baseline.length, templateRaster };
          click.draws.push(change);
          if (click.draws.length > 1024) click.draws.shift();
          if (changed && click.inputAt !== null) {
            click.firstChangedDrawAt ??= drawnAt;
            requestAnimationFrame(() => {
              click.firstChangedPresentationAt ??= at();
              if (!click.expectedRasterTemplate && click.targetObservedAt !== null && drawnAt >= click.targetObservedAt)
                click.targetPicturePresentationAt ??= at();
            });
          }
          if (click.expectedRasterTemplate && click.inputAt !== null && templateRaster?.exactMatch) {
            click.firstExactTargetDrawAt ??= drawnAt;
            requestAnimationFrame(() => {
              click.firstExactTargetPresentationAt ??= at();
              if (click.targetObservedAt !== null)
                click.targetPicturePresentationAt ??= click.firstExactTargetPresentationAt;
            });
          }
        }
        // Native pictures contain the game's cursor raster; a local pointer
        // presentation value is never counted as evidence without a bitmap.
        const template = probe.cursor;
        if (frame.rgb565 && template && frame !== probe.lastCursorFrame) {
          probe.lastCursorFrame = frame;
          probe.cursorDraws++;
          record.cursorTemplateTested = true;
          const visited = new Set();
          let match = null;
          for (let index = probe.positions.length - 1; index >= 0; index--) {
            const position = probe.positions[index];
            if (drawnAt - position.at > 500) break;
            const key = `${position.gameX}:${position.gameY}`;
            if (visited.has(key)) continue;
            visited.add(key);
            const x = position.gameX;
            const y = position.gameY;
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            if (
              template.pixels.every(
                ([dx, dy, colour]) =>
                  x + dx >= 0 &&
                  x + dx < frame.width &&
                  y + dy >= 0 &&
                  y + dy < frame.height &&
                  frame.rgb565[(y + dy) * frame.width + x + dx] === colour,
              )
            ) {
              match = { x, y, inputAt: position.at, exactTemplatePixels: template.pixels.length };
              break;
            }
          }
          if (match) {
            probe.cursorMatches++;
            record.cursorMatched = true;
            record.cursorInputAt = match.inputAt;
            requestAnimationFrame(() =>
              enqueue({
                kind: 'drawn-native-cursor',
                ...match,
                drawAt: drawnAt,
                presentationOpportunityAt: at(),
                latencyMs: at() - match.inputAt,
                source: 'Exact game-raster cursor template in picture actually passed to backend.draw; following rAF',
              }),
            );
          }
        }
        enqueue(record);
      },
    };
    probe.drain = () => ({
      samples: probe.samples.splice(0),
      counts: { ...probe.counts },
      lostEvidence: probe.lostEvidence,
      firstAt: probe.firstAt,
      lastAt: probe.lastAt,
      cursorDraws: probe.cursorDraws,
      cursorMatches: probe.cursorMatches,
      draws: presentation.count,
    });
    probe.reset = () => {
      probe.counts = {};
      probe.samples.length = 0;
      probe.positions.length = 0;
      probe.lostEvidence = 0;
      probe.firstAt = probe.lastAt = null;
      probe.cursorDraws = probe.cursorMatches = 0;
      probe.currentEvent = null;
    };
    probe.stop = () => {
      for (const type of types) window.removeEventListener(type, listen, true);
      delete window.__phase7InputProbe;
      delete window.__phase7Presentation;
    };
    window.__phase7InputProbe = probe;
    window.__phase7Presentation = presentation;
    return { eventEvidenceBound: 8192, pointerHistoryBound: 4096, drawHistoryBound: 512 };
  });
}

/** An exact cursor template requires A/B/A raster evidence. Stable foreground
 * pixels at A which disappear at B are retained; repeated A rejects animated
 * background pixels. The operator must inspect the accompanying screenshots. */
export async function calibratePhase7Cursor({ page, area, out, label, shot }) {
  const bounds = await page.locator('#screen').boundingBox();
  assert(bounds, 'Visible game canvas required');
  const dimensions = await page.evaluate(() => {
    const frame = window.__phase7Presentation?.latestFrame;
    return frame ? { width: frame.width, height: frame.height } : null;
  });
  assert(dimensions, 'Presentation probe has an actual native picture');
  const requestedA = { x: area.x + area.width * 0.3, y: area.y + area.height * 0.4 };
  const moveA = { x: Math.floor(requestedA.x), y: Math.floor(requestedA.y) };
  let a = { ...moveA };
  const b = { x: Math.floor(area.x + area.width * 0.7), y: Math.floor(area.y + area.height * 0.65) };
  await page.evaluate((a) => {
    window.__phase7Presentation.calibrationPoint = a;
    window.__phase7Presentation.latestPatch = null;
  }, a);
  const move = async (point) => {
    await page.mouse.move(
      bounds.x + (point.x / dimensions.width) * bounds.width,
      bounds.y + (point.y / dimensions.height) * bounds.height,
    );
    await delay(220);
  };
  const patch = () =>
    page.evaluate(
      ({ a }) => {
        const patch = window.__phase7Presentation?.latestPatch;
        if (!patch || patch.x !== Math.floor(a.x) || patch.y !== Math.floor(a.y)) return null;
        const pixels = [];
        for (let dy = -16; dy < 48; dy++)
          for (let dx = -16; dx < 48; dx++) {
            const index = (dy + 16) * 64 + dx + 16;
            if (patch.valid[index]) pixels.push([dx, dy, patch.pixels[index]]);
          }
        return pixels;
      },
      { a },
    );
  await move(moveA);
  const actualA = await page.evaluate(() => {
    const position = window.__phase7InputProbe.latest;
    return Number.isFinite(position?.gameX) && Number.isFinite(position?.gameY)
      ? { x: position.gameX, y: position.gameY }
      : null;
  });
  if (actualA && (actualA.x !== a.x || actualA.y !== a.y)) {
    a = actualA;
    await page.evaluate((a) => {
      window.__phase7Presentation.calibrationPoint = a;
      window.__phase7Presentation.latestPatch = null;
    }, a);
    await delay(220);
  }
  const first = await patch();
  const screenshotA = await shot?.(`${label}-cursor-calibration-a`);
  await move(b);
  const background = await patch();
  const screenshotB = await shot?.(`${label}-cursor-calibration-b`);
  // Repeat the identical browser coordinate, while the sampled patch remains
  // centred at the game's actual integer position. Moving to that rounded
  // native value again could compound a CSS rounding offset.
  await move(moveA);
  const repeat = await patch();
  const repeatedPosition = await page.evaluate(() => {
    const position = window.__phase7InputProbe.latest;
    return { x: position?.gameX, y: position?.gameY };
  });
  await page.evaluate(() => {
    window.__phase7Presentation.calibrationPoint = null;
    window.__phase7Presentation.latestPatch = null;
  });
  const repeatAtActualA = repeatedPosition.x === a.x && repeatedPosition.y === a.y;
  const pixels = repeatAtActualA
    ? (first?.filter((pixel, index) => pixel[2] !== background?.[index]?.[2] && pixel[2] === repeat?.[index]?.[2]) ??
      [])
    : [];
  const path = join(out, `${label}-cursor-template.json`);
  const result = {
    source: 'Actual RGB565 backend picture A/B/A differential',
    requestedA,
    a,
    b,
    repeatedPosition,
    repeatAtActualA,
    exactTemplatePixels: pixels.length,
    screenshots: [screenshotA, screenshotB],
    path,
  };
  await writeFile(path, JSON.stringify({ ...result, pixels }, null, 2));
  await page.evaluate((pixels) => {
    window.__phase7InputProbe.cursor = pixels.length ? { pixels } : null;
  }, pixels);
  return result;
}

/** Continuous trusted CDP input; commands run in groups without retaining a
 * session's promises. The page's received event rate is the reported rate.
 * area and optional clickPoint are native picture pixels, never control RPCs. */
export async function runPhase7InputStream({
  page,
  cdp,
  worker,
  out,
  label,
  rate,
  seconds = 30,
  area,
  clickPoint,
  record,
  shot,
  waitOwnerIdle,
  asyncOwnerNotifications = false,
  onInputCheckpoint,
  observeState,
  requireBattle = false,
  selectionKeys = [],
  pointerOnly = false,
}) {
  assert([250, 1000].includes(rate), 'Phase7 mouse rates are 250 and 1000');
  assert(seconds >= 30 && seconds <= 600, 'Phase7 stream lasts 30 to 600 seconds');
  assert(
    Array.isArray(selectionKeys) && selectionKeys.every((key) => typeof key === 'string' && /^[0-9p]$/.test(key)),
    'Optional selection keys must be ordinary control-group digits or p for combat units',
  );
  const evidence = await createPhase7EvidenceStream(join(out, `${label}-${rate}hz.ndjson`));
  const agent = typeof worker === 'function' ? worker() : worker;
  let nativeInputBaseline = null;
  let nativeInputTotals = null;
  let bounds;
  let dimensions;
  try {
    nativeInputBaseline = agent ? await startPhase7NativeInputObserver(agent) : null;
    bounds = await page.locator('#screen').boundingBox();
    assert(bounds, 'Visible game canvas required');
    dimensions = await page.evaluate(() => {
      const frame = window.__phase7Presentation?.latestFrame;
      if (!frame) throw new Error('Native presentation probe missing');
      window.__phase7InputProbe.reset();
      return { width: frame.width, height: frame.height };
    });
  } catch (error) {
    await evidence.append({ kind: 'input-stream-failure', stage: 'setup', at: Date.now(), error: String(error) });
    if (agent && nativeInputBaseline) {
      try {
        let pending = await drainPhase7NativeInputObserver(agent);
        for (const sample of pending.samples) await evidence.append(sample);
        while (pending.pending) {
          await waitOwnerIdle?.();
          await delay(100);
          pending = await drainPhase7NativeInputObserver(agent);
          for (const sample of pending.samples) await evidence.append(sample);
        }
      } catch {
        // The owning harness still performs browser/game cleanup when this
        // context or its deadline is gone. Preserve the setup failure.
      }
      await drainPhase7NativeInputObserver(agent, true).catch(() => {});
    }
    const result = {
      label,
      completed: false,
      reason: `Stream setup failed: ${String(error)}`,
      error: String(error),
      requestedHz: rate,
      requestedSeconds: seconds,
      actualSeconds: 0,
      inputActiveSeconds: 0,
      sentPointerCommands: 0,
      artifact: await evidence.close(),
    };
    await record?.('human-mouse-stream', result);
    return result;
  }
  const css = (point) => ({
    x: bounds.x + (point.x / dimensions.width) * bounds.width,
    y: bounds.y + (point.y / dimensions.height) * bounds.height,
  });
  const start = performance.now();
  let end = start + seconds * 1000;
  let ownerWaitMs = 0;
  const activeElapsedMs = () => performance.now() - start - ownerWaitMs;
  let emitted = 0;
  let dragging = false;
  let rightHeld = false;
  let shiftHeld = false;
  let selectionKeyHeld = null;
  const selectionSequence = [];
  let ownerPaused = false;
  let pauseStartedAt = null;
  let pauseReason = null;
  let resumeOwner;
  let ownerResume = Promise.resolve();
  let resumingOwner = null;
  let collectingStopped = false;
  let stopCollecting;
  const collectorStop = new Promise((resolve) => {
    stopCollecting = resolve;
  });
  let collection;
  let guarding;
  let lastActionBucket = -1;
  let rssHighBytes = Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024);
  let totals = { counts: {}, lostEvidence: 0, firstAt: null, lastAt: null, cursorDraws: 0, cursorMatches: 0 };
  let streamStopReason = null;
  let streamError = null;
  let inputStoppedAt = null;
  let inputCheckpointStarted = false;
  let inputCheckpointEnded = false;
  const cleanupErrors = [];
  const pointerIntervals = {
    events: 0,
    trustedEvents: 0,
    firstAt: null,
    lastAt: null,
    maxGapMs: null,
    halfSecondBuckets: 0,
    emptyHalfSecondBuckets: 0,
    continuousAtRequestedRate: 'UNVERIFIED',
    limitation:
      'Actual event timestamps, gaps and half-second counts expose bursts; an overall average is not continuous input evidence',
  };
  let pointerBucket = null;
  const finishPointerBucket = async () => {
    if (!pointerBucket) return;
    await evidence.append({ kind: 'received-pointer-half-second', ...pointerBucket });
    pointerIntervals.halfSecondBuckets++;
  };
  const latencyBins = new Map();
  let cursorSamples = 0;
  let cursorMaxMs = null;
  const cursorCoverage = {
    freshNativePictures: 0,
    testedNativePictures: 0,
    matchedNativePictures: 0,
    unmatchedNativePictures: 0,
    firstMovementAt: null,
    lastMovementAt: null,
    firstNativePictureAt: null,
    lastNativePictureAt: null,
    firstMatchedPresentationAt: null,
    lastMatchedPresentationAt: null,
    maxNativePictureGapMs: 0,
    maxUnmeasuredMovementIntervalMs: 0,
    nativePictureGapsAbove50Ms: 0,
    unmeasuredIntervalsAbove50Ms: 0,
  };
  let firstNativeMatchState = null;
  let lastNativeMatchState = null;
  let nativeMatchStateSamples = 0;
  let nativeMatchStateErrors = 0;
  const flush = async () => {
    totals = await page.evaluate(() => window.__phase7InputProbe.drain());
    for (const sample of totals.samples) {
      await evidence.append(sample);
      if (sample.kind === 'page-input' && sample.type === 'pointermove') {
        pointerIntervals.events++;
        if (sample.trusted) pointerIntervals.trustedEvents++;
        pointerIntervals.firstAt ??= sample.at;
        if (pointerIntervals.lastAt !== null)
          pointerIntervals.maxGapMs = Math.max(pointerIntervals.maxGapMs ?? 0, sample.at - pointerIntervals.lastAt);
        pointerIntervals.lastAt = sample.at;
        const bucket = Math.floor((sample.at - pointerIntervals.firstAt) / 500);
        if (pointerBucket?.index !== bucket) {
          await finishPointerBucket();
          if (pointerBucket && bucket > pointerBucket.index + 1) {
            const count = bucket - pointerBucket.index - 1;
            pointerIntervals.emptyHalfSecondBuckets += count;
            await evidence.append({
              kind: 'received-pointer-empty-half-seconds',
              firstIndex: pointerBucket.index + 1,
              count,
              firstAt: pointerIntervals.firstAt,
              bucketMs: 500,
            });
          }
          pointerBucket = {
            index: bucket,
            startAt: pointerIntervals.firstAt + bucket * 500,
            endAt: pointerIntervals.firstAt + (bucket + 1) * 500,
            events: 0,
            trustedEvents: 0,
            coalescedPositions: 0,
          };
        }
        pointerBucket.events++;
        if (sample.trusted) pointerBucket.trustedEvents++;
        pointerBucket.coalescedPositions += Math.max(0, sample.coalesced - 1);
        cursorCoverage.firstMovementAt ??= sample.at;
        cursorCoverage.lastMovementAt = sample.at;
      }
      if (sample.kind === 'native-picture-draw' && sample.freshNativeRaster) {
        cursorCoverage.freshNativePictures++;
        cursorCoverage.firstNativePictureAt ??= sample.at;
        if (cursorCoverage.lastNativePictureAt !== null) {
          const gap = sample.at - cursorCoverage.lastNativePictureAt;
          cursorCoverage.maxNativePictureGapMs = Math.max(cursorCoverage.maxNativePictureGapMs, gap);
          if (gap > 50) cursorCoverage.nativePictureGapsAbove50Ms++;
        }
        cursorCoverage.lastNativePictureAt = sample.at;
        if (sample.cursorTemplateTested) {
          cursorCoverage.testedNativePictures++;
          if (sample.cursorMatched) cursorCoverage.matchedNativePictures++;
          else cursorCoverage.unmatchedNativePictures++;
        }
      }
      if (sample.kind === 'drawn-native-cursor') {
        cursorSamples++;
        cursorMaxMs = Math.max(cursorMaxMs ?? 0, sample.latencyMs);
        const bucket = Math.ceil(sample.latencyMs * 10) / 10;
        latencyBins.set(bucket, (latencyBins.get(bucket) ?? 0) + 1);
        cursorCoverage.firstMatchedPresentationAt ??= sample.presentationOpportunityAt;
        const previous = cursorCoverage.lastMatchedPresentationAt ?? cursorCoverage.firstMovementAt;
        if (previous !== null) {
          const gap = sample.presentationOpportunityAt - previous;
          cursorCoverage.maxUnmeasuredMovementIntervalMs = Math.max(
            cursorCoverage.maxUnmeasuredMovementIntervalMs,
            gap,
          );
          if (gap > 50) cursorCoverage.unmeasuredIntervalsAbove50Ms++;
        }
        cursorCoverage.lastMatchedPresentationAt = sample.presentationOpportunityAt;
      }
    }
    if (agent) {
      nativeInputTotals = await drainPhase7NativeInputObserver(agent);
      for (const sample of nativeInputTotals.samples) await evidence.append(sample);
    }
    const maxRssBytes = process.resourceUsage().maxRSS * 1024;
    rssHighBytes = Math.max(rssHighBytes, process.memoryUsage().rss, maxRssBytes);
    await evidence.append({ kind: 'acceptance-memory', at: Date.now(), ...process.memoryUsage(), maxRssBytes });
    if (observeState) {
      try {
        const observation = {
          kind: 'native-match-state',
          at: Date.now(),
          ...(selectionKeys.length
            ? { latestSelectionInput: selectionSequence.length ? { ...selectionSequence.at(-1) } : null }
            : {}),
          state: await observeState(),
        };
        firstNativeMatchState ??= observation;
        lastNativeMatchState = observation;
        nativeMatchStateSamples++;
        await evidence.append(observation);
        if (requireBattle && (observation.state?.nativeModal === true || observation.state?.ownAliveAssets === 0)) {
          streamStopReason ??=
            observation.state.ownAliveAssets === 0
              ? 'Battle ended: genuine observation reports zero living owned assets'
              : 'Battle interface left: genuine native modal state is active';
        } else if (
          requireBattle &&
          (observation.state?.nativeModal !== false ||
            observation.state?.renderReaderError ||
            !Number.isInteger(observation.state?.localHouse) ||
            observation.state.localHouse < 0 ||
            !Number.isFinite(observation.state?.logicFrame) ||
            !Number.isFinite(observation.state?.ownAliveAssets))
        ) {
          streamStopReason ??= 'Battle continuity UNVERIFIED: required genuine state is unknown';
        }
      } catch (error) {
        nativeMatchStateErrors++;
        await evidence.append({ kind: 'native-match-state-error', at: Date.now(), error: String(error) });
        if (requireBattle)
          streamStopReason ??= `Battle continuity UNVERIFIED: state observation failed: ${String(error)}`;
      }
    }
  };
  const checkpoint = async (stage, detail = {}) => {
    const description = { label, rate, requireBattle, atNodeMs: performance.now(), ...detail };
    await evidence.append({ kind: 'input-window-checkpoint', stage, ...description });
    await onInputCheckpoint?.(stage, description);
  };
  const retainFailure = async (stage, error) => {
    const description = `${stage}: ${String(error)}`;
    streamError ??= description;
    streamStopReason ??= description;
    if (cleanupErrors.length < 8) cleanupErrors.push(description);
    await evidence
      .append({ kind: 'input-stream-failure', at: Date.now(), stage, error: String(error) })
      .catch(() => {});
  };
  const cleanupStep = async (stage, operation) => {
    try {
      await operation();
    } catch (error) {
      await retainFailure(stage, error);
    }
  };
  const pauseForOwner = async (reason = 'positive-owner-hold') => {
    if (ownerPaused || collectingStopped) return;
    ownerPaused = true;
    pauseStartedAt = performance.now();
    pauseReason = reason;
    ownerResume = new Promise((resolve) => {
      resumeOwner = resolve;
    });
    await checkpoint('wait-start');
  };
  const resumeAfterOwner = async () => {
    if (!ownerPaused) return;
    if (resumingOwner) return resumingOwner;
    resumingOwner = (async () => {
      await checkpoint('wait-end', {
        ownerHeld: pauseReason === 'positive-owner-hold' ? true : 'UNVERIFIED',
        elapsedMs: performance.now() - pauseStartedAt,
      });
      const elapsed = performance.now() - pauseStartedAt;
      ownerWaitMs += elapsed;
      end += elapsed;
      ownerPaused = false;
      resumeOwner?.();
      resumeOwner = null;
    })();
    try {
      await resumingOwner;
    } finally {
      resumingOwner = null;
    }
  };
  const ordinaryInput = async (method, payload) => {
    while (ownerPaused && !streamStopReason) await Promise.race([ownerResume, collectorStop]);
    if (streamStopReason || collectingStopped) throw new Error('Input producer stopped by its owning guard');
    return cdp.send(method, payload);
  };
  try {
    if (requireBattle && !observeState) throw new Error('Battle continuity UNVERIFIED: no genuine state observer');
    await checkpoint('start');
    inputCheckpointStarted = true;
    if (requireBattle) await flush();
    collection = (async () => {
      while (!collectingStopped && !streamStopReason) {
        await Promise.race([delay(500), collectorStop]);
        if (collectingStopped || streamStopReason) break;
        try {
          await flush();
        } catch (error) {
          await retainFailure('evidence-collector', error);
          resumeOwner?.();
          break;
        }
      }
    })();
    guarding = (async () => {
      while (!collectingStopped && !streamStopReason && waitOwnerIdle) {
        await Promise.race([delay(500), collectorStop]);
        if (collectingStopped || streamStopReason) break;
        try {
          // Guard polling is independent of disk/page collection as well as
          // the single writer. A slow flush cannot delay detecting a hold or
          // cancellation. Only an already dispatched group may finish.
          if (waitOwnerIdle && !asyncOwnerNotifications) await pauseForOwner('legacy-owner-guard');
          await waitOwnerIdle?.({
            onHeld: pauseForOwner,
            onBlocked: () => {
              streamStopReason ??= 'Owner input guard blocked';
              resumeOwner?.();
            },
            isStopped: () => collectingStopped || !!streamStopReason,
          });
          await resumeAfterOwner();
        } catch (error) {
          await retainFailure('owner-guard', error);
          resumeOwner?.();
          break;
        }
      }
    })();
    while (!streamStopReason && performance.now() < end) {
      while (ownerPaused && !streamStopReason) await Promise.race([ownerResume, collectorStop]);
      if (streamStopReason) break;
      const now = performance.now();
      const wanted = Math.min(Math.floor(((now - start - ownerWaitMs) * rate) / 1000) + 1, seconds * rate);
      const sends = [];
      // Limit outstanding CDP commands. Burst dispatch compensates timer
      // granularity without retaining more than one small group of promises.
      while (emitted < wanted && sends.length < 16) {
        const phase = emitted / rate;
        const point = {
          x: area.x + area.width * (0.5 + 0.4 * Math.sin(phase * 2.7)),
          y: area.y + area.height * (0.5 + 0.4 * Math.sin(phase * 1.9)),
        };
        sends.push(
          ordinaryInput('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            ...css(point),
            buttons: dragging ? 1 : 0,
            button: dragging ? 'left' : 'none',
          }),
        );
        emitted++;
      }
      const sent = await Promise.allSettled(sends);
      const failedSend = sent.find((result) => result.status === 'rejected');
      if (failedSend) throw failedSend.reason;
      const actionBucket = Math.floor(activeElapsedMs() / 2000);
      if (!pointerOnly && actionBucket !== lastActionBucket) {
        lastActionBucket = actionBucket;
        const point = css(clickPoint ?? { x: area.x + area.width * 0.5, y: area.y + area.height * 0.5 });
        await ordinaryInput('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          ...point,
          buttons: dragging ? 1 : 0,
          button: dragging ? 'left' : 'none',
        });
        if (actionBucket % 3 === 0) {
          await ordinaryInput('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            ...point,
            button: 'left',
            buttons: 1,
            clickCount: 1,
          });
          dragging = true;
        } else if (dragging) {
          await ordinaryInput('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            ...point,
            button: 'left',
            buttons: 0,
            clickCount: 1,
          });
          dragging = false;
        } else {
          await ordinaryInput('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            ...point,
            button: 'right',
            buttons: 2,
            clickCount: 1,
          });
          rightHeld = true;
          await ordinaryInput('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            ...point,
            button: 'right',
            buttons: 0,
            clickCount: 1,
          });
          rightHeld = false;
        }
        await ordinaryInput('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          ...point,
          deltaX: 0,
          deltaY: actionBucket % 2 ? 80 : -80,
          buttons: dragging ? 1 : 0,
        });
        await ordinaryInput('Input.dispatchKeyEvent', {
          type: 'keyDown',
          key: 'Shift',
          code: 'ShiftLeft',
          windowsVirtualKeyCode: 16,
          nativeVirtualKeyCode: 16,
          modifiers: 8,
        });
        shiftHeld = true;
        await ordinaryInput('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Shift',
          code: 'ShiftLeft',
          windowsVirtualKeyCode: 16,
          nativeVirtualKeyCode: 16,
          modifiers: 0,
        });
        shiftHeld = false;
        if (selectionKeys.length) {
          const key = selectionKeys[selectionSequence.length % selectionKeys.length];
          const input = {
            index: selectionSequence.length,
            key,
            actionBucket,
            startedAt: Date.now(),
            activeElapsedMs: activeElapsedMs(),
            keyUpSent: false,
          };
          selectionSequence.push(input);
          const keyFields = {
            key,
            code: key === 'p' ? 'KeyP' : `Digit${key}`,
            windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
            nativeVirtualKeyCode: key.toUpperCase().charCodeAt(0),
            modifiers: 0,
          };
          selectionKeyHeld = keyFields;
          await ordinaryInput('Input.dispatchKeyEvent', { type: 'keyDown', ...keyFields });
          try {
            await delay(60);
          } finally {
            // Release an owned key even if the owner guard stops new input.
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...keyFields });
            selectionKeyHeld = null;
            input.keyUpSent = true;
            input.finishedAt = Date.now();
            await evidence.append({ kind: 'selection-key-input', ...input });
          }
        }
      }
      if (emitted >= Math.floor((activeElapsedMs() * rate) / 1000)) await delay(1);
    }
  } catch (error) {
    await retainFailure('stream', error);
  } finally {
    inputStoppedAt = performance.now();
    collectingStopped = true;
    stopCollecting();
    resumeOwner?.();
    await cleanupStep('end-owned-wait', resumeAfterOwner);
    if (inputCheckpointStarted)
      await cleanupStep('input-window-end', async () => {
        await checkpoint('end', {
          completed: !streamStopReason && !streamError,
          reason: streamStopReason,
          nativeMatchStateErrors,
          inputStoppedAtNodeMs: inputStoppedAt,
        });
        inputCheckpointEnded = true;
      });
    await cleanupStep('stop-evidence-collector', async () => {
      await Promise.all([collection, guarding]);
    });
    if (dragging)
      await cleanupStep('release-drag', async () => {
        // Release an already owned press even after cancellation or deadline.
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...css(clickPoint ?? { x: area.x + area.width * 0.5, y: area.y + area.height * 0.5 }),
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
      });
    if (rightHeld)
      await cleanupStep('release-right-button', () =>
        cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          ...css(clickPoint ?? { x: area.x + area.width * 0.5, y: area.y + area.height * 0.5 }),
          button: 'right',
          buttons: 0,
          clickCount: 1,
        }),
      );
    if (shiftHeld)
      await cleanupStep('release-shift', () =>
        cdp.send('Input.dispatchKeyEvent', {
          type: 'keyUp',
          key: 'Shift',
          code: 'ShiftLeft',
          windowsVirtualKeyCode: 16,
          nativeVirtualKeyCode: 16,
          modifiers: 0,
        }),
      );
    if (selectionKeyHeld)
      await cleanupStep('release-selection-key', () =>
        cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...selectionKeyHeld }),
      );
    await delay(100);
    await cleanupStep('final-evidence-flush', flush);
    if (agent) {
      // Let every genuine GUI-consumption promise finish. No acceptance
      // cutoff is invented: the owning harness enforces the task deadline
      // and its owner-idle callback while observation remains bounded.
      await cleanupStep('final-native-input-drain', async () => {
        while (nativeInputTotals?.pending) {
          await waitOwnerIdle?.();
          await delay(100);
          await flush();
        }
      });
      await cleanupStep('stop-native-input-observer', async () => {
        nativeInputTotals = await drainPhase7NativeInputObserver(agent, true);
        for (const sample of nativeInputTotals.samples) await evidence.append(sample);
      });
    }
  }
  await finishPointerBucket();
  if (inputCheckpointStarted)
    await cleanupStep('input-window-result', () =>
      checkpoint('result', {
        completed: !streamStopReason && !streamError,
        reason: streamStopReason,
        nativeMatchStateErrors,
      }),
    );
  const artifact = await evidence.close();
  const lastMeasured = cursorCoverage.lastMatchedPresentationAt ?? cursorCoverage.firstMovementAt;
  if (lastMeasured !== null && cursorCoverage.lastMovementAt !== null) {
    const gap = Math.max(0, cursorCoverage.lastMovementAt - lastMeasured);
    cursorCoverage.maxUnmeasuredMovementIntervalMs = Math.max(cursorCoverage.maxUnmeasuredMovementIntervalMs, gap);
    if (gap > 50) cursorCoverage.unmeasuredIntervalsAbove50Ms++;
  }
  const quantile = (q) => {
    let seen = 0;
    for (const [ms, count] of [...latencyBins].sort((a, b) => a[0] - b[0])) {
      seen += count;
      if (seen >= cursorSamples * q) return ms;
    }
    return null;
  };
  const duration = (performance.now() - start) / 1000;
  const inputSeconds = totals.lastAt > totals.firstAt ? (totals.lastAt - totals.firstAt) / 1000 : duration;
  const result = {
    label,
    completed: !streamStopReason && !streamError,
    reason: streamStopReason,
    error: streamError,
    cleanupErrors,
    requireBattle,
    ...(selectionKeys.length
      ? {
          selectionInput: {
            keys: selectionKeys,
            intervalMs: 2000,
            sequence: selectionSequence,
            source: 'Ordinary trusted CDP key events; actual selected counts belong to native-match-state evidence',
          },
        }
      : {}),
    requestedHz: rate,
    requestedSeconds: seconds,
    actualSeconds: duration,
    activeSeconds: duration - ownerWaitMs / 1000,
    inputActiveSeconds: (inputStoppedAt - start - ownerWaitMs) / 1000,
    ownerWaitSeconds: ownerWaitMs / 1000,
    inputCheckpoints: { started: inputCheckpointStarted, ended: inputCheckpointEnded },
    producer: {
      singleWriter: true,
      pointerCommandsInFlightLimit: 16,
      readOnlyCollectorIndependent: true,
      asyncOwnerNotifications,
      ownerGuardMode: asyncOwnerNotifications ? 'Positive hold/cancellation notification' : 'Legacy conservative pause',
    },
    pointerIntervals,
    sentPointerCommands: emitted,
    pageEvents: totals.counts,
    receivedPointerEventsHz: (totals.counts.pointermove ?? 0) / inputSeconds,
    receivedPositionsIncludingBrowserCoalescingHz:
      ((totals.counts.pointermove ?? 0) + (totals.counts.coalescedPositions ?? 0)) / inputSeconds,
    lostEvidence: totals.lostEvidence,
    nodeRssHighBytes: rssHighBytes,
    nativeInput: nativeInputTotals
      ? {
          ...nativeInputBaseline,
          started: nativeInputTotals.started,
          acknowledged: nativeInputTotals.acknowledged,
          errors: nativeInputTotals.errors,
          lostEvidence: nativeInputTotals.lostEvidence,
          pendingAtEnd: nativeInputTotals.pending,
          source: 'Read-only real Native Input request/GUI-consumption ACK observer, drained at every evidence flush',
        }
      : null,
    nativeMatchState: {
      samples: nativeMatchStateSamples,
      errors: nativeMatchStateErrors,
      first: firstNativeMatchState,
      last: lastNativeMatchState,
    },
    cursor: {
      samples: cursorSamples,
      actualPictureDraws: totals.cursorDraws,
      exactMatches: totals.cursorMatches,
      p50Ms: quantile(0.5),
      p95Ms: quantile(0.95),
      maxMs: cursorMaxMs,
      coverage: {
        ...cursorCoverage,
        matchedFractionOfTestedPictures: cursorCoverage.testedNativePictures
          ? cursorCoverage.matchedNativePictures / cursorCoverage.testedNativePictures
          : null,
        continuousWithin50Ms: 'UNVERIFIED',
        reason: !cursorSamples
          ? 'No exact native-raster cursor samples; the entire movement interval remains unmeasured'
          : 'Exact matches cover sampled native pictures; unmatched shapes/positions and periods without pictures are not proven. Repeated coordinates use the newest matching event in the bounded history.',
        ownerWaitIncludedInWallGaps: ownerWaitMs > 0,
      },
      limitation:
        'Following-rAF presentation opportunity; exact game-raster template, not an input ACK or local cursor value',
    },
    artifact,
    screenshot: null,
  };
  try {
    result.screenshot = await shot?.(`${label}-${rate}hz-finished`);
  } catch (error) {
    result.screenshotError = String(error);
  }
  await record?.('human-mouse-stream', result);
  return result;
}

/** Timestamp only the genuine request and native picture observer. This never
 * submits native input; all mutations still originate in trusted page input. */
async function installWorkerClickProbe(worker) {
  return worker.evaluate(() => {
    if (globalThis.__phase7ClickRpcProbe) {
      globalThis.__phase7ClickRpcProbe.samples.length = 0;
      return;
    }
    const connection = globalThis.__auditCore?.connection;
    if (!connection) throw new Error('Audited native connection unavailable');
    const probe = { samples: [] };
    const put = (record) => {
      if (probe.samples.length < 2048) probe.samples.push(record);
    };
    const original = connection.request.bind(connection);
    connection.request = function (type, payload, ...rest) {
      const startAt = performance.timeOrigin + performance.now();
      const fields =
        type === 10 && payload?.byteLength === 16
          ? Array.from(new Uint32Array(payload.buffer, payload.byteOffset, 4))
          : null;
      const result = original(type, payload, ...rest);
      result.then(
        () => put({ kind: 'rpc', type, fields, startAt, endAt: performance.timeOrigin + performance.now() }),
        (error) =>
          put({
            kind: 'rpc-error',
            type,
            fields,
            startAt,
            endAt: performance.timeOrigin + performance.now(),
            error: String(error),
          }),
      );
      return result;
    };
    connection.onPicture((picture) =>
      put({
        kind: 'native-picture-arrival',
        at: performance.timeOrigin + performance.now(),
        frame: picture.frame,
        width: picture.width,
        height: picture.height,
      }),
    );
    globalThis.__phase7ClickRpcProbe = probe;
  });
}

export async function measurePhase7MenuClick({
  page,
  cdp,
  worker,
  click,
  point,
  targetNativePoint,
  label,
  expectedControlId,
  expectedRasterTemplate,
  record,
  out,
}) {
  const agent = typeof worker === 'function' ? worker() : worker;
  assert(agent, 'Audited native Worker required');
  await installPhase7InputProbe(page);
  await installWorkerClickProbe(agent);
  if (expectedRasterTemplate) {
    assert.equal(expectedRasterTemplate.expectedControlId, expectedControlId, 'Raster template control must agree');
    assert(expectedRasterTemplate.matchPixels?.length, 'A nonempty exact target label pixel mask is required');
    await page.evaluate((template) => {
      window.__phase7Presentation.menuRasterTemplate = template;
      window.__phase7Presentation.latestMenuTemplateRaster = null;
    }, expectedRasterTemplate);
  }
  const nativePoint = targetNativePoint ?? point;
  if (nativePoint) {
    const bounds = await page.locator('#screen').boundingBox();
    const dimensions = await page.evaluate(() => {
      const frame = window.__phase7Presentation.latestFrame;
      return { width: frame.width, height: frame.height };
    });
    await page.mouse.move(
      bounds.x + (nativePoint.x / dimensions.width) * bounds.width,
      bounds.y + (nativePoint.y / dimensions.height) * bounds.height,
    );
    await delay(100);
  }
  await page.evaluate(
    ({ label, nativePoint, expectedRasterTemplate }) => {
      const presentation = window.__phase7Presentation;
      const frame = presentation.latestRaster;
      if (!frame?.pixels?.length) throw new Error('Actual RGB565 menu picture samples required');
      const baseline = [];
      const templateBaseline = expectedRasterTemplate ? presentation.latestMenuTemplateRaster : null;
      if (expectedRasterTemplate) {
        if (!templateBaseline?.dimensionsMatch)
          throw new Error('Fresh target ROI snapshot with matching dimensions required');
        if (templateBaseline.exactMatch) throw new Error('Target label pixels were already present before the click');
      }
      const point = nativePoint ?? window.__phase7InputProbe.latest;
      let rasterIndex = 0;
      for (let y = 0; y < frame.height; y += frame.spacing)
        for (let x = 0; x < frame.width; x += frame.spacing) {
          const colour = frame.pixels[rasterIndex++];
          // Exclude button feedback and the cursor; a destination/animation
          // repaint must change pixels elsewhere in the actual native picture.
          if (point && Math.abs(x - point.x) < 64 && Math.abs(y - point.y) < 64) continue;
          baseline.push([x, y, colour]);
        }
      presentation.menuClick = {
        label,
        baseline,
        rasterSnapshotSource: 'Compact RGB565 samples copied during the actual draw before client buffer recycling',
        baselineSampledAt: frame.at,
        expectedRasterTemplate: expectedRasterTemplate
          ? {
              expectedControlId: expectedRasterTemplate.expectedControlId,
              source: expectedRasterTemplate.source,
              sourceSha256: expectedRasterTemplate.sourceSha256,
              criterion: expectedRasterTemplate.criterion,
              rect: expectedRasterTemplate.rect,
              spacing: expectedRasterTemplate.spacing,
              requiredPixels: expectedRasterTemplate.matchPixels.length,
              referenceRejections: expectedRasterTemplate.referenceRejections,
            }
          : null,
        templateBaseline,
        inputAt: null,
        targetObservedAt: null,
        firstChangedDrawAt: null,
        firstChangedPresentationAt: null,
        targetPicturePresentationAt: null,
        firstExactTargetDrawAt: null,
        firstExactTargetPresentationAt: null,
        draws: [],
      };
      const down = (event) => {
        if (event.target?.id !== 'screen') return;
        presentation.menuClick.inputAt ??= performance.timeOrigin + performance.now();
        window.removeEventListener('pointerdown', down, true);
      };
      window.addEventListener('pointerdown', down, true);
      presentation.menuClick.stop = () => window.removeEventListener('pointerdown', down, true);
    },
    { label, nativePoint, expectedRasterTemplate },
  );
  let targetState = null;
  let failure = null;
  try {
    if (click) await click();
    else {
      assert(nativePoint, 'Provide ordinary click callback or native picture point');
      const bounds = await page.locator('#screen').boundingBox();
      const size = await page.evaluate(() => {
        const frame = window.__phase7Presentation.latestFrame;
        return { width: frame.width, height: frame.height };
      });
      const position = {
        x: bounds.x + (nativePoint.x / size.width) * bounds.width,
        y: bounds.y + (nativePoint.y / size.height) * bounds.height,
      };
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        ...position,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        ...position,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      });
    }
    const until = Date.now() + 15000;
    let targetObserved = expectedControlId === undefined;
    if (targetObserved)
      await page.evaluate(() => {
        window.__phase7Presentation.menuClick.targetObservedAt = performance.timeOrigin + performance.now();
      });
    while (Date.now() < until) {
      if (!targetObserved) {
        targetState = await agent.evaluate(async () =>
          JSON.parse(new TextDecoder().decode(await globalThis.__auditCore.connection.request(14))),
        );
        targetObserved = targetState.controls?.some(
          (control) => control.id === expectedControlId && control.visible !== false,
        );
        if (targetObserved)
          await page.evaluate(() => {
            const click = window.__phase7Presentation.menuClick;
            click.targetObservedAt = performance.timeOrigin + performance.now();
            if (click.expectedRasterTemplate && click.firstExactTargetPresentationAt !== null)
              click.targetPicturePresentationAt ??= click.firstExactTargetPresentationAt;
          });
      }
      const complete = await page.evaluate(
        () => window.__phase7Presentation.menuClick.targetPicturePresentationAt !== null,
      );
      if (targetObserved && complete) break;
      await delay(10);
    }
  } catch (error) {
    failure = String(error.stack ?? error);
  }
  const measured = await page.evaluate(() => {
    const click = window.__phase7Presentation.menuClick;
    click.stop();
    delete window.__phase7Presentation.menuClick;
    delete window.__phase7Presentation.menuRasterTemplate;
    delete window.__phase7Presentation.latestMenuTemplateRaster;
    const { baseline, stop, ...result } = click;
    return { ...result, rasterSamples: baseline.length };
  });
  const native = await agent.evaluate(async () => ({
    samples: globalThis.__phase7ClickRpcProbe.samples.splice(0),
    input: JSON.parse(new TextDecoder().decode(await globalThis.__auditCore.connection.request(14))),
    diagnostics: JSON.parse(new TextDecoder().decode(await globalThis.__auditCore.connection.request(11))),
  }));
  const inputRpcs = native.samples.filter(
    (sample) =>
      sample.kind === 'rpc' &&
      sample.type === 10 &&
      sample.fields?.[0] === 1 &&
      [0x0201, 0x0202].includes(sample.fields[1]),
  );
  const firstInputStart = inputRpcs[0]?.startAt ?? null;
  const lastInputAck = inputRpcs.at(-1)?.endAt ?? null;
  const result = {
    label,
    expectedControlId: expectedControlId ?? null,
    error: failure,
    inputAt: measured.inputAt,
    firstChangedNativePictureOnScreenAt: measured.firstChangedPresentationAt,
    targetNativePictureOnScreenAt: measured.targetPicturePresentationAt,
    targetRasterCriterion: measured.expectedRasterTemplate?.criterion ?? null,
    targetRasterSource: measured.expectedRasterTemplate?.source ?? null,
    targetRasterRequiredPixels: measured.expectedRasterTemplate?.requiredPixels ?? null,
    targetRasterFirstExactDrawAt: measured.firstExactTargetDrawAt,
    targetRasterFirstExactPresentationAt: measured.firstExactTargetPresentationAt,
    clickToFirstChangedPictureMs:
      measured.firstChangedPresentationAt !== null && measured.inputAt !== null
        ? measured.firstChangedPresentationAt - measured.inputAt
        : null,
    clickToTargetPictureMs:
      measured.targetPicturePresentationAt !== null && measured.inputAt !== null
        ? measured.targetPicturePresentationAt - measured.inputAt
        : null,
    pageToInputRpcMs: firstInputStart !== null && measured.inputAt !== null ? firstInputStart - measured.inputAt : null,
    inputHopMs: inputRpcs.map((sample) => sample.endAt - sample.startAt),
    inputAckToTargetControlsMs:
      lastInputAck !== null && measured.targetObservedAt !== null ? measured.targetObservedAt - lastInputAck : null,
    targetControlsToPresentedPictureMs:
      measured.targetObservedAt !== null && measured.targetPicturePresentationAt !== null
        ? measured.targetPicturePresentationAt - measured.targetObservedAt
        : null,
    guiQueueLastUs: native.input.lastDeliveryQueueUs ?? null,
    guiQueueMaxUs: native.input.maxDeliveryQueueUs ?? null,
    nativeHandlerLastUs: native.input.lastHandlerUs ?? null,
    nativeHandlerMaxUs: native.input.maxHandlerUs ?? null,
    pictureEncoding: native.diagnostics.picture ?? null,
    limitation:
      'Screen timing is actual backend native raster draw followed by rAF, not physical scanout. With a supplied template, every target label pixel must match exactly and the expected native control must independently appear; without it, target-control observation gives an upper bound including poll latency. Handler/encoding counters are agent last/max, not exact per-click attribution. Game animation is not inferred from ACK timing alone.',
    evidencePath: join(out, `${label}-menu-click.json`),
  };
  await writeFile(
    result.evidencePath,
    JSON.stringify({ ...result, presentation: measured, native, targetState }, null, 2),
  );
  await record?.('menu-click-latency', result);
  return result;
}
