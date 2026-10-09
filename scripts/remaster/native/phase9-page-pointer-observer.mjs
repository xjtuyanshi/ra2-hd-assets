import assert from 'node:assert/strict';

/** Read-only evidence for the real page cursor. This does not set cursor state,
 * submit native requests, synthesize game input, or claim physical scanout. */
export async function installPhase9PagePointerObserver(page, { maxSamples = 16384 } = {}) {
  assert(Number.isInteger(maxSamples) && maxSamples > 0 && maxSamples <= 65536);
  return page.evaluate(
    ({ maxSamples }) => {
      if (window.__phase9PointerProbe) return { alreadyInstalled: true };
      const screen = document.getElementById('screen');
      const presentation = window.__phase7Presentation;
      if (!screen || !presentation?.draw) throw new Error('Real screen and Phase 7 draw observer required');
      const probe = {
        scene: 'unlabelled',
        samples: [],
        lostEvidence: 0,
        sequence: 0,
        displayFrame: 0,
        raf: 0,
        latestEvent: null,
        sceneFirstPointerEvent: null,
        latestFrame: presentation.latestFrame,
        latestCursorFrame: null,
        nativeSnapshot: null,
        previousArt: null,
        artBitmap: null,
        destroyed: false,
      };
      const at = () => performance.now();
      const put = (sample) => {
        if (probe.samples.length < maxSamples) probe.samples.push(sample);
        else probe.lostEvidence++;
      };
      const bitmap = (canvas) => {
        if (!canvas?.width || !canvas.height || canvas.width * canvas.height > 1024 * 1024) return null;
        const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data;
        if (!pixels) return null;
        let hash = 2166136261,
          visiblePixels = 0;
        for (let i = 0; i < pixels.length; i++) hash = Math.imul(hash ^ pixels[i], 16777619) >>> 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) visiblePixels++;
        return { width: canvas.width, height: canvas.height, fnv1a: hash.toString(16).padStart(8, '0'), visiblePixels };
      };
      const current = ({ includeBitmap = false, target = null } = {}) => {
        const canvas = document.getElementById('native-page-cursor');
        // The presenter intentionally removes hardware cursor RGBA after the
        // page overlay consumes it. The optional update seam observes that
        // actual pre-removal metadata and must survive later presenter draws.
        const frame = probe.latestCursorFrame ?? probe.latestFrame;
        const box = screen.getBoundingClientRect();
        const cursorBox = canvas?.getBoundingClientRect();
        const actualCursorFrame = probe.latestCursorFrame;
        const pointer = frame && 'pointer' in frame ? frame.pointer : (probe.nativeSnapshot?.pointer ?? null);
        const hardware = !pointer
          ? actualCursorFrame
            ? (actualCursorFrame.cursor ?? null)
            : (probe.nativeSnapshot?.hardware ?? null)
          : null;
        const scaleX = frame ? box.width / frame.width : null;
        const scaleY = frame ? box.height / frame.height : null;
        const hotspotX = pointer?.hotspotX ?? hardware?.hotspotX ?? null;
        const hotspotY = pointer?.hotspotY ?? hardware?.hotspotY ?? null;
        const transform = canvas ? new DOMMatrixReadOnly(canvas.style.transform) : null;
        const actualHotspot =
          transform && hotspotX !== null && hotspotY !== null && scaleX && scaleY
            ? { x: transform.m41 + hotspotX * scaleX, y: transform.m42 + hotspotY * scaleY }
            : null;
        const style = canvas ? getComputedStyle(canvas) : null;
        // The first real pointer event can paint art before the next native
        // draw. Refresh a changed canvas size so that this synchronous paint
        // is not misreported using the previous empty bitmap cache.
        const artBitmap =
          includeBitmap ||
          (canvas && (canvas.width !== probe.artBitmap?.width || canvas.height !== probe.artBitmap?.height))
            ? bitmap(canvas)
            : probe.artBitmap;
        probe.artBitmap = artBitmap;
        return {
          at: at(),
          scene: probe.scene,
          pageCursorElements: document.querySelectorAll('#native-page-cursor').length,
          display: style?.display ?? null,
          opacity: style?.opacity ?? null,
          visible:
            !!canvas &&
            style?.display !== 'none' &&
            style?.visibility !== 'hidden' &&
            style?.opacity !== '0' &&
            (artBitmap?.visiblePixels ?? 0) > 0,
          visibleArtPixels: artBitmap?.visiblePixels ?? null,
          screenCursor: getComputedStyle(screen).cursor,
          documentHasFocus: document.hasFocus(),
          documentHidden: document.hidden,
          documentVisibilityState: document.visibilityState,
          pointerLocked: document.pointerLockElement === screen,
          viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
          gameDimensions: frame ? { width: frame.width, height: frame.height } : null,
          screenBox: { left: box.left, top: box.top, width: box.width, height: box.height },
          cursorBox: cursorBox
            ? { left: cursorBox.left, top: cursorBox.top, width: cursorBox.width, height: cursorBox.height }
            : null,
          transform: canvas?.style.transform ?? null,
          clipPath: canvas?.style.clipPath ?? null,
          scale: { x: scaleX, y: scaleY },
          pointer: pointer ? { ...pointer } : null,
          hardware: hardware
            ? {
                handle: hardware.handle,
                width: hardware.width,
                height: hardware.height,
                hotspotX: hardware.hotspotX,
                hotspotY: hardware.hotspotY,
                x: hardware.x ?? null,
                y: hardware.y ?? null,
              }
            : null,
          metadataSource: actualCursorFrame
            ? 'Actual nativeCursor.update frame, before presenter cursor removal'
            : frame?.pointer
              ? 'Actual frame delivered to renderer'
              : probe.nativeSnapshot
                ? 'Read-only NativeCore snapshot, sampled separately'
                : null,
          nativeSnapshotAt: probe.nativeSnapshot?.at ?? null,
          actualHotspot,
          hotspotError:
            target && actualHotspot ? { x: actualHotspot.x - target.x, y: actualHotspot.y - target.y } : null,
          bitmap: includeBitmap ? artBitmap : null,
        };
      };
      const art = () => {
        const canvas = document.getElementById('native-page-cursor');
        const pixels = bitmap(canvas);
        probe.artBitmap = pixels;
        return pixels ? `${pixels.width}x${pixels.height}:${pixels.fnv1a}` : 'none';
      };
      const recordArt = (source) => {
        const key = art();
        if (key === probe.previousArt) return;
        const before = probe.previousArt;
        probe.previousArt = key;
        const seenAt = at(),
          event = probe.latestEvent;
        const record = {
          kind: 'actual-page-cursor-art-change',
          scene: probe.scene,
          source,
          seenAt,
          before,
          after: key,
          latestPointerSequence: event?.sequence ?? null,
          latestPointerAt: event?.eventAt ?? null,
          delaySinceLatestPointerMs: event ? seenAt - event.eventAt : null,
          firstPointerInSceneAt: probe.sceneFirstPointerEvent?.eventAt ?? null,
          delaySinceFirstPointerInSceneMs: probe.sceneFirstPointerEvent
            ? seenAt - probe.sceneFirstPointerEvent.eventAt
            : null,
          observation: current({ includeBitmap: true, target: event ? { x: event.x, y: event.y } : null }),
          caveat:
            'An art transition after the latest pointer event is association only; animated art and game-state changes also change shape. Use labelled stationary scene transitions to assess state response.',
        };
        put(record);
        requestAnimationFrame(() => {
          record.nextRafAt = at();
          record.delayToNextRafSincePointerMs = event ? record.nextRafAt - event.eventAt : null;
          record.artStillCurrentAtNextRaf = key === art();
        });
      };
      const originalDraw = presentation.draw;
      presentation.draw = function (args) {
        const result = originalDraw.call(this, args);
        probe.latestFrame = args[0];
        recordArt('Actual renderer draw, after native page-cursor frame update');
        return result;
      };
      const eventSamples = new WeakMap();
      const event = (e) => {
        if (e.target !== screen || e.pointerType !== 'mouse') return;
        const sample = {
          kind: 'page-pointer-event',
          scene: probe.scene,
          sequence: ++probe.sequence,
          type: e.type,
          trusted: e.isTrusted,
          eventAt: e.timeStamp,
          observerAt: at(),
          x: e.clientX,
          y: e.clientY,
          buttons: e.buttons,
          eventDisplayFrame: probe.displayFrame,
        };
        probe.latestEvent = sample;
        probe.sceneFirstPointerEvent ??= sample;
        put(sample);
        eventSamples.set(e, sample);
        requestAnimationFrame(() => {
          sample.nextRafAt = at();
          sample.nextDisplayFrame = probe.displayFrame;
          sample.pointerToNextRafMs = sample.nextRafAt - sample.eventAt;
          sample.observerToNextRafMs = sample.nextRafAt - sample.observerAt;
          sample.supersededBeforeNextRaf = sample.sequence !== probe.sequence;
          sample.atNextRaf = current({ target: { x: sample.x, y: sample.y } });
        });
      };
      const types = ['pointermove', 'pointerdown', 'pointerup', 'pointerenter'];
      for (const type of types) window.addEventListener(type, event, true);
      const lifecycle = (event) => {
        if (event.type.startsWith('pointer') && event.target !== screen) return;
        const sample = {
          kind: 'page-pointer-lifecycle',
          scene: probe.scene,
          type: event.type,
          trusted: event.isTrusted,
          eventAt: event.timeStamp,
          observerAt: at(),
          target:
            event.target === window ? 'window' : event.target === document ? 'document' : (event.target?.id ?? null),
          beforeHandlers: current({ includeBitmap: true }),
        };
        put(sample);
        eventSamples.set(event, sample);
        requestAnimationFrame(() => {
          sample.nextRafAt = at();
          sample.atNextRaf = current({ includeBitmap: true });
        });
      };
      const lifecycleListeners = [
        [window, 'pointerleave', true],
        [window, 'pointercancel', true],
        [window, 'blur', false],
        [window, 'focus', false],
        [window, 'resize', false],
        [document, 'visibilitychange', false],
        [document, 'pointerlockchange', false],
        [document, 'fullscreenchange', false],
      ];
      for (const [target, type, capture] of lifecycleListeners) target.addEventListener(type, lifecycle, capture);
      // A capture-listener microtask can run before the target listeners. Only
      // an actual ancestor bubble callback establishes synchronous post-target
      // observation. Non-bubbling events retain rAF evidence without inventing
      // an after-handler sample.
      const afterTarget = (event) => {
        if (event.eventPhase !== Event.BUBBLING_PHASE) return;
        const sample = eventSamples.get(event);
        if (!sample || sample.afterHandlers) return;
        sample.afterHandlers = current({
          includeBitmap: sample.kind === 'page-pointer-lifecycle',
          target: sample.kind === 'page-pointer-event' ? { x: sample.x, y: sample.y } : null,
        });
        sample.afterHandlersSource = 'Actual document/window bubble listener after target input listeners';
      };
      const bubbleTypes = [...new Set([...types, ...lifecycleListeners.map(([, type]) => type)])];
      for (const type of bubbleTypes) {
        document.addEventListener(type, afterTarget);
        window.addEventListener(type, afterTarget);
      }
      let latestDisplay = document.getElementById('native-page-cursor')?.style.display ?? null;
      const visibilityObserver = new MutationObserver(() => {
        const display = document.getElementById('native-page-cursor')?.style.display ?? null;
        if (display === latestDisplay) return;
        put({
          kind: 'page-cursor-css-display-change',
          scene: probe.scene,
          at: at(),
          before: latestDisplay,
          after: display,
          observation: current({ includeBitmap: true }),
        });
        latestDisplay = display;
      });
      const cursorCanvas = document.getElementById('native-page-cursor');
      if (cursorCanvas) visibilityObserver.observe(cursorCanvas, { attributes: true, attributeFilter: ['style'] });
      const tick = () => {
        probe.displayFrame++;
        probe.raf = requestAnimationFrame(tick);
      };
      probe.raf = requestAnimationFrame(tick);
      probe.current = current;
      probe.setScene = (scene) => {
        probe.scene = scene;
        probe.latestEvent = null;
        probe.sceneFirstPointerEvent = null;
        put({ kind: 'scene-start', scene, at: at(), observation: current({ includeBitmap: true }) });
      };
      probe.frame = (frame) => {
        // Retain only bounded metadata, never the recyclable native picture
        // buffer or a second copy of the hardware cursor's RGBA.
        const cursor = frame.cursor;
        probe.latestCursorFrame = {
          width: frame.width,
          height: frame.height,
          ...('pointer' in frame ? { pointer: frame.pointer ? { ...frame.pointer } : frame.pointer } : {}),
          cursor: cursor
            ? {
                handle: cursor.handle,
                width: cursor.width,
                height: cursor.height,
                hotspotX: cursor.hotspotX,
                hotspotY: cursor.hotspotY,
                x: cursor.x,
                y: cursor.y,
              }
            : null,
        };
        recordArt('Actual nativeCursor.update post-render source seam');
      };
      probe.stop = () => {
        if (probe.destroyed) return;
        probe.destroyed = true;
        for (const type of types) window.removeEventListener(type, event, true);
        for (const [target, type, capture] of lifecycleListeners) target.removeEventListener(type, lifecycle, capture);
        for (const type of bubbleTypes) {
          document.removeEventListener(type, afterTarget);
          window.removeEventListener(type, afterTarget);
        }
        visibilityObserver.disconnect();
        cancelAnimationFrame(probe.raf);
        if (presentation.draw !== originalDraw) presentation.draw = originalDraw;
        delete window.__phase9PointerProbe;
      };
      window.__phase9PointerProbe = probe;
      recordArt('Runtime observer installation');
      return {
        maxSamples,
        source:
          'Actual browser mouse events, actual composited cursor bitmap/CSS, actual frame metadata and following rAF',
        limitation:
          'rAF is a page display opportunity; physical scanout and native raster suppression require separate live screenshot evidence',
      };
    },
    { maxSamples },
  );
}

export async function setPhase9PointerScene(page, scene) {
  assert(typeof scene === 'string' && scene.length > 0 && scene.length < 160);
  return page.evaluate((scene) => {
    const probe = window.__phase9PointerProbe;
    if (!probe) throw new Error('Phase 9 page-pointer observer is not installed');
    probe.setScene(scene);
    return probe.current({ includeBitmap: true });
  }, scene);
}

/** Reuse the existing bounded Phase 7 evidence flush during a long real-input
 * stream. This changes only audit copies, never input or rendering behavior. */
export async function streamPhase9PointerEvidenceThroughPhase7(page, enabled = true) {
  return page.evaluate((enabled) => {
    const pointer = window.__phase9PointerProbe,
      input = window.__phase7InputProbe;
    if (!pointer || !input?.drain) throw new Error('Both actual page observers are required');
    if (!enabled) {
      if (input.__phase9OriginalDrain) {
        input.drain = input.__phase9OriginalDrain;
        delete input.__phase9OriginalDrain;
      }
      return { enabled: false };
    }
    if (input.__phase9OriginalDrain) return { enabled: true, alreadyInstalled: true };
    input.__phase9OriginalDrain = input.drain;
    input.drain = function () {
      const result = input.__phase9OriginalDrain.call(this),
        ready = [],
        pending = [];
      for (const sample of pointer.samples) {
        const awaitsRaf = ['page-pointer-event', 'page-pointer-lifecycle', 'actual-page-cursor-art-change'].includes(
          sample.kind,
        );
        (awaitsRaf && sample.nextRafAt === undefined ? pending : ready).push(sample);
      }
      pointer.samples.splice(0, pointer.samples.length, ...pending);
      for (const sample of ready) result.samples.push({ ...sample, pageTimeOrigin: performance.timeOrigin });
      result.samples.push({
        kind: 'phase9-page-pointer-evidence-flush',
        at: performance.timeOrigin + performance.now(),
        flushed: ready.length,
        pending: pending.length,
        lostEvidence: pointer.lostEvidence,
      });
      return result;
    };
    return {
      enabled: true,
      source:
        'Existing Phase 7 half-second disk-backpressured evidence flush; completed Phase 9 cursor/rAF records only',
    };
  }, enabled);
}

/** The Worker snapshot is read-only and explicitly separate from page timing. */
export async function readPhase9WorkerPointerState(worker, { inspect = false } = {}) {
  const agent = typeof worker === 'function' ? worker() : worker;
  return agent
    ? agent.evaluate(
        async ({ inspect }) => {
          const core = globalThis.__auditCore;
          const hardware = core?.systemCursor;
          const alpha = (rgba) => {
            if (!rgba) return null;
            let nonzero = 0,
              opaque = 0;
            for (let i = 3; i < rgba.length; i += 4) {
              if (rgba[i]) nonzero++;
              if (rgba[i] === 255) opaque++;
            }
            return { pixels: rgba.length / 4, nonzeroAlphaPixels: nonzero, opaquePixels: opaque };
          };
          const result = {
            at: performance.timeOrigin + performance.now(),
            pointer: core?.pointer ? { ...core.pointer } : null,
            suppressed: core?.pointerSuppressed ?? null,
            hardware: hardware
              ? {
                  handle: hardware.handle,
                  width: hardware.width,
                  height: hardware.height,
                  hotspotX: hardware.hotspotX,
                  hotspotY: hardware.hotspotY,
                  alpha: alpha(hardware.rgba),
                }
              : null,
            cursorSnapshotSupported: core?.hello?.limits?.cursorSnapshot ?? null,
          };
          if (inspect && core?.connection) {
            const bytes = await core.connection.request(14, new Uint8Array(new Uint32Array([2]).buffer));
            result.rawHardwareSnapshot = {
              bytes: bytes.length,
              header:
                bytes.length >= 28
                  ? Array.from(new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 28)))
                  : null,
              allZero: bytes.every((value) => value === 0),
              alpha: alpha(bytes.subarray(28)),
              source: 'Read-only InputState cursor-snapshot flag 2 response',
            };
            const read = async (address, length) => (await core.connection.read(address, length)).bytes;
            const [mouseBytes, shapeBytes] = await Promise.all([read(0x887640, 4), read(0xabf294, 4)]);
            const u32 = (bytes, offset = 0) =>
              new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
            const mouse = u32(mouseBytes),
              shape = u32(shapeBytes);
            result.yrPresentationFields = { mouse, globalShape: shape };
            if (mouse >= 0x10000 && !(mouse & 3)) {
              const object = await read(mouse, 0x44);
              const view = new DataView(object.buffer, object.byteOffset, object.byteLength);
              Object.assign(result.yrPresentationFields, {
                vtable: u32(object),
                objectShape: u32(object, 4),
                frame: view.getInt32(8, true),
                softwareVisibilityCounter: view.getInt32(12, true),
                softwareMode: view.getUint8(0x10),
                x: view.getInt32(0x14, true),
                y: view.getInt32(0x18, true),
                hotspotX: view.getInt32(0x3c, true),
                hotspotY: view.getInt32(0x40, true),
              });
            }
            if (shape >= 0x10000 && !(shape & 3)) {
              const header = await read(shape, 8);
              const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
              result.yrPresentationFields.shapeHeader = Array.from({ length: 4 }, (_, i) =>
                view.getUint16(i * 2, true),
              );
            }
          }
          return result;
        },
        { inspect },
      )
    : null;
}

export async function readPhase9PagePointerObserver(
  page,
  { worker = null, drain = false, inspectNative = false } = {},
) {
  const native = await readPhase9WorkerPointerState(worker, { inspect: inspectNative });
  return page.evaluate(
    ({ native, drain }) => {
      const probe = window.__phase9PointerProbe;
      if (!probe) throw new Error('Phase 9 page-pointer observer is not installed');
      if (native) probe.nativeSnapshot = native;
      const samples = drain ? probe.samples.splice(0) : [...probe.samples];
      const events = samples.filter((sample) => sample.kind === 'page-pointer-event');
      const presented = events.filter((sample) => sample.nextRafAt !== undefined && !sample.supersededBeforeNextRaf);
      const summarize = (values) => {
        values.sort((a, b) => a - b);
        return {
          n: values.length,
          p50Ms: values[Math.max(0, Math.ceil(values.length * 0.5) - 1)] ?? null,
          p95Ms: values[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? null,
          maxMs: values.at(-1) ?? null,
        };
      };
      return {
        scene: probe.scene,
        current: probe.current({ includeBitmap: true }),
        nativeSnapshot: native,
        lostEvidence: probe.lostEvidence,
        samples,
        summary: {
          events: events.length,
          supersededBeforeNextRaf: events.filter((sample) => sample.supersededBeforeNextRaf).length,
          pointerToNextRaf: summarize(presented.map((sample) => sample.pointerToNextRafMs)),
          afterHandlerHotspotSamples: events.filter((sample) => sample.afterHandlers?.hotspotError).length,
          afterHandlerSamples: events.filter((sample) => sample.afterHandlers).length,
          noAfterHandlerObservation: events.filter((sample) => !sample.afterHandlers).length,
          missingAtHandler: events.filter((sample) => sample.afterHandlers && !sample.afterHandlers.visible).length,
          missingAtNextRaf: presented.filter((sample) => !sample.atNextRaf?.visible).length,
          duplicatePageCursorElements: presented.filter((sample) => sample.atNextRaf?.pageCursorElements !== 1).length,
          maxHotspotErrorAtHandlerCssPx: events.reduce((maximum, sample) => {
            const error = sample.afterHandlers?.hotspotError;
            return error ? Math.max(maximum ?? 0, Math.abs(error.x), Math.abs(error.y)) : maximum;
          }, null),
          maxHotspotErrorAtNextRafCssPx: presented.reduce((maximum, sample) => {
            const error = sample.atNextRaf?.hotspotError;
            return error ? Math.max(maximum ?? 0, Math.abs(error.x), Math.abs(error.y)) : maximum;
          }, null),
        },
        limitation:
          'CSS pointer-count/visibility observations do not independently exclude a baked-in native cursor; inspect the live page and native screenshots. Separately sampled hardware hotspots cannot establish event-time precision.',
      };
    },
    { native, drain },
  );
}
