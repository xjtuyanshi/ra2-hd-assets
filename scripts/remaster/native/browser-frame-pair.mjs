import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const SLOT = '__nativeBrowserFramePair';
const RING_LIMIT = 12;
const MAX_WIDTH = 1600;

/**
 * Capture actual browser drawing buffers and delivered native pictures only.
 * Keyed mode uses real Backslash; a non-keyed visual-only page needs no input.
 * No replay, redraw, pause, clock adjustment, game-state write or alteration of
 * the existing canvases is performed.
 */
export async function captureSameFramePair({ page, worker, out, prefix, event, combatObserverSource, zFactor }) {
  const owner = randomUUID();
  const agent = typeof worker === 'function' ? worker() : worker;
  const directory = resolve(out);
  if (!prefix || /[\\/]/.test(prefix)) throw new Error('Frame-pair prefix must be a file-name prefix');
  const reportPath = join(directory, `${prefix}-same-frame-pair.json`);
  const report = {
    startedAt: new Date().toISOString(),
    met: false,
    input: 'real browser Backslash only; all capture operations are read-only',
    maximumNativePictures: RING_LIMIT,
    maximumAttempts: 8,
    maximumGpuCaptureWaitMs: 500,
    combatRequired: !!combatObserverSource,
    attempts: [],
    artifacts: {},
    cleanup: { unsubscribed: false, hdRestored: false },
  };
  let installed = false;
  let captureWithoutSwitch = false;
  const emit = async (name, proof) => {
    await event?.(name, proof);
  };
  const status = () =>
    page.evaluate(() => {
      const diagnostic = window.__hdBridge?.diagnostics;
      const passthrough = window.__hdBridge?.passthrough;
      return {
        enabled: diagnostic?.enabled ?? null,
        shown: diagnostic?.shown ?? null,
        passthrough: passthrough ? { ...passthrough } : null,
        requestedPassthrough: new URL(location.href).searchParams.get('hd-passthrough'),
      };
    });
  const setHd = async (wanted) => {
    const before = await status();
    if (before.enabled === null) throw new Error('HD development diagnostics are unavailable');
    if (before.enabled !== wanted) await page.keyboard.press('Backslash');
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const current = await status();
      if (current.enabled === wanted) return current;
      await delay(20);
    }
    throw new Error(`Real Backslash did not set HD enabled=${wanted}`);
  };
  try {
    await mkdir(directory, { recursive: true });
    if (!agent) throw new Error('Native Playwright worker is unavailable');
    const initial = await status();
    if (initial.shown !== true) throw new Error('A visible HD battlefield is required before pairing');
    captureWithoutSwitch = initial.passthrough?.flags === 0 && initial.passthrough.keyed === false;
    report.configuration = {
      actualPassthrough: initial.passthrough,
      requestedPassthrough: initial.requestedPassthrough,
      mode: captureWithoutSwitch ? 'alternate-visual-only-non-keyed' : 'normal-keyed-Backslash-trail',
      purpose: captureWithoutSwitch
        ? 'Separate visual-only comparison using the existing hd-passthrough=none/0 capability; not owner-mode performance or overlay acceptance'
        : 'Normal configured HD view with native overlays',
    };
    if (captureWithoutSwitch)
      report.input = 'no capture input; enabled HD and complete non-keyed native pictures observed read-only';
    report.observer = await agent.evaluate(
      ({ slot, owner, limit }) => {
        const connection = globalThis.__auditCore?.connection;
        if (!connection?.onPicture || !connection.pictureDecoder)
          throw new Error('Audited native connection/picture decoder is unavailable');
        if (globalThis[slot]) throw new Error('Another native picture capture already owns the observer slot');
        const capture = { owner, ring: [], copied: 0, errors: [], stop: null };
        const copy = () => {
          try {
            // Decoder owns this separate baseline. NativeCore may transfer the
            // returned picture pixels before other listeners run.
            const source = connection.pictureDecoder.previous;
            if (!source || !source.pixels?.length) return;
            const picture = {
              frame: source.frame,
              width: source.width,
              height: source.height,
              atMs: performance.timeOrigin + performance.now(),
              pixels: source.pixels.slice(),
            };
            capture.ring.push(picture);
            if (capture.ring.length > limit) capture.ring.shift();
            capture.copied++;
          } catch (error) {
            if (capture.errors.length < 8) capture.errors.push(String(error));
          }
        };
        const unsubscribe = connection.onPicture(copy);
        capture.stop = () => {
          unsubscribe();
          capture.ring.length = 0;
        };
        globalThis[slot] = capture;
        copy();
        return { decoderPrivateBaselineReadable: true, ringLimit: limit, initialPictures: capture.ring.length };
      },
      { slot: SLOT, owner, limit: RING_LIMIT },
    );
    installed = true;
    // The preceding performance capture is already finished and persisted by
    // the caller. This short independent log supplies completed draw tags.
    await page.evaluate(() => window.__hdBridge.diagnostics.startCapture());
    for (let number = 1; number <= 8 && !report.met; number++) {
      await setHd(true);
      const shownDeadline = Date.now() + 6000;
      while ((await status()).shown !== true && Date.now() < shownDeadline) await delay(50);
      if ((await status()).shown !== true) throw new Error('HD battlefield did not return between pair attempts');
      const drawDeadline = Date.now() + 1500;
      while (Date.now() < drawDeadline) {
        const ready = await page.evaluate(() => !!window.__hdBridge.diagnostics.capture?.draws.length);
        if (ready) break;
        await delay(20);
      }
      const attempt = {
        number,
        startedAt: new Date().toISOString(),
        hdFrames: [],
        originalFrames: [],
        hdBufferRejections: [],
        matched: false,
      };
      report.attempts.push(attempt);
      // With passthrough off, the native transport already delivers complete
      // original pictures while HD remains enabled. Keyed mode retains the
      // original Backslash/trail path and all of its strict matching tests.
      if (!captureWithoutSwitch) await setHd(false);
      const until = Date.now() + 520;
      while (Date.now() < until && !report.met) {
        const captureTimeoutMs = Math.min(500, until - Date.now());
        if (captureTimeoutMs < 50) break;
        const hd = await page.evaluate(
          async ({ maxWidth, combatObserverSource, zFactor, captureWithoutSwitch, captureTimeoutMs }) => {
            const bridge = window.__hdBridge;
            const diagnostic = bridge?.diagnostics;
            if (typeof diagnostic?.captureNextDraw !== 'function')
              throw new Error('Read-only HD next-draw GPU capture diagnostic is unavailable');
            const before = {
              enabled: diagnostic.enabled,
              shown: diagnostic.shown,
              passthrough: bridge.passthrough ? { ...bridge.passthrough } : null,
            };
            let draw;
            try {
              // This diagnostic copies the actual submitted canvas texture in
              // the draw's own task. It never requests a replay or extra render.
              draw = await diagnostic.captureNextDraw(captureTimeoutMs);
            } catch (error) {
              return { rejected: 'HD-next-draw-capture-error', error: String(error) };
            }
            const state = draw?.state;
            const after = {
              enabled: diagnostic.enabled,
              shown: diagnostic.shown,
              passthrough: bridge.passthrough ? { ...bridge.passthrough } : null,
            };
            if (
              captureWithoutSwitch &&
              (!before.enabled ||
                !before.shown ||
                !after.enabled ||
                !after.shown ||
                !draw?.shown ||
                before.passthrough?.flags !== 0 ||
                before.passthrough.keyed !== false ||
                after.passthrough?.flags !== 0 ||
                after.passthrough.keyed !== false ||
                (draw.passthrough && (draw.passthrough.flags !== 0 || draw.passthrough.keyed !== false)))
            )
              return { rejected: 'non-keyed-enabled-HD-capture-precondition-changed', frame: draw?.frame ?? null };
            if (!draw || !state?.view || !state.sidebar?.frame || state.frame !== draw.frame)
              return {
                rejected: 'draw-state-frame-or-view-mismatch',
                frame: draw?.frame ?? null,
                stateFrame: state?.frame ?? null,
              };
            const combat = combatObserverSource ? Function(`return (${combatObserverSource})`)()(state, zFactor) : null;
            if (combatObserverSource && !combat?.inView)
              return { rejected: 'no-visible-combat-in-captured-HD-frame', frame: draw.frame, combat };
            const size = state.sidebar.frame;
            if (draw.nativeSize?.width !== size.width || draw.nativeSize?.height !== size.height)
              return { rejected: 'draw-native-dimension-mismatch', frame: draw.frame };
            const rect = draw.rect;
            if (
              !rect ||
              ![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) ||
              rect.x < 0 ||
              rect.y < 0 ||
              rect.width <= 0 ||
              rect.height <= 0 ||
              rect.x + rect.width > size.width ||
              rect.y + rect.height > size.height
            )
              return { rejected: 'draw-native-tactical-rect-mismatch', frame: draw.frame };
            if (
              !Number.isInteger(draw.width) ||
              !Number.isInteger(draw.height) ||
              draw.width <= 0 ||
              draw.height <= 0 ||
              draw.width * draw.height > 16777216 ||
              !(draw.pixels instanceof Uint8Array) ||
              draw.pixels.length !== draw.width * draw.height * 4
            )
              return { rejected: 'invalid-HD-GPU-pixel-buffer', frame: draw.frame };
            // Detached canvases turn unchanged captured RGBA into PNG artifacts;
            // neither one is attached to the page or alters a live canvas.
            const source = document.createElement('canvas');
            source.width = draw.width;
            source.height = draw.height;
            const sourceContext = source.getContext('2d');
            const output = document.createElement('canvas');
            output.width = Math.min(maxWidth, rect.width);
            output.height = Math.max(1, Math.round((rect.height * output.width) / rect.width));
            const context = output.getContext('2d');
            if (!context || !sourceContext) throw new Error('HD screenshot artifact canvas is unavailable');
            const image = sourceContext.createImageData(draw.width, draw.height);
            image.data.set(draw.pixels);
            sourceContext.putImageData(image, 0, 0);
            context.drawImage(source, 0, 0, output.width, output.height);
            const pixels = context.getImageData(0, 0, output.width, output.height).data;
            const stride = Math.max(1, Math.floor((output.width * output.height) / 65536));
            const colours = new Set();
            let visibleSamples = 0;
            for (let pixel = 0; pixel < output.width * output.height; pixel += stride) {
              const offset = pixel * 4;
              if (pixels[offset + 3] && pixels[offset] + pixels[offset + 1] + pixels[offset + 2] > 4) {
                visibleSamples++;
                if (colours.size < 64)
                  colours.add((pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2]);
              }
            }
            if (visibleSamples < 32 || colours.size < 8)
              return {
                rejected: 'blank-or-uniform-HD-drawing-buffer',
                frame: draw.frame,
                visibleSamples,
                colours: colours.size,
              };
            return {
              frame: draw.frame,
              drawAtMs: draw.drawAtMs,
              shown: draw.shown,
              map: draw.map,
              view: draw.view,
              nativeSize: size,
              rect,
              width: output.width,
              height: output.height,
              sourceSize: { width: draw.width, height: draw.height },
              captureMethod: 'read-only GPU copy of actual next presented HD draw',
              format: draw.format,
              visibleSamples,
              colours: colours.size,
              combat,
              passthrough: draw.passthrough ? { ...draw.passthrough } : null,
              passthroughObservations: { before, after },
              png: output.toDataURL('image/png'),
            };
          },
          {
            maxWidth: MAX_WIDTH,
            combatObserverSource: combatObserverSource ?? null,
            zFactor: zFactor ?? null,
            captureWithoutSwitch,
            captureTimeoutMs,
          },
        );
        if (!hd || hd.rejected) {
          if (hd?.rejected && attempt.hdBufferRejections.length < 12) attempt.hdBufferRejections.push(hd);
          await delay(5);
          continue;
        }
        if (!attempt.hdFrames.includes(hd.frame)) attempt.hdFrames.push(hd.frame);
        const native = await agent.evaluate(
          ({ slot, owner, frame, rect, size }) => {
            const capture = globalThis[slot];
            if (!capture || capture.owner !== owner) throw new Error('Native picture observer ownership changed');
            const available = capture.ring.map((picture) => picture.frame);
            for (const picture of [...capture.ring].reverse()) {
              if (picture.frame !== frame || picture.width !== size.width || picture.height !== size.height) continue;
              let keyPixels = 0;
              for (let y = rect.y; y < rect.y + rect.height; y++)
                for (let x = rect.x; x < rect.x + rect.width; x++)
                  if (picture.pixels[y * picture.width + x] === 0xf81f) keyPixels++;
              const keyPixelRatio = keyPixels / (rect.width * rect.height);
              // A full native picture may contain a few naturally magenta
              // pixels, but a keyed tactical carrier is not an original picture.
              if (keyPixelRatio > 0.001) continue;
              const bytes = new Uint8Array(picture.pixels.buffer, picture.pixels.byteOffset, picture.pixels.byteLength);
              let binary = '';
              for (let offset = 0; offset < bytes.length; offset += 32768)
                binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
              return {
                matched: true,
                frame: picture.frame,
                width: picture.width,
                height: picture.height,
                atMs: picture.atMs,
                keyPixels,
                keyPixelRatio,
                available,
                pixelsBase64: btoa(binary),
              };
            }
            return { matched: false, available };
          },
          { slot: SLOT, owner, frame: hd.frame, rect: hd.rect, size: hd.nativeSize },
        );
        attempt.originalFrames = native.available;
        if (!native.matched) {
          await delay(5);
          continue;
        }
        const pngs = await page.evaluate(
          ({ picture, rect, maxWidth, cropWidth, cropHeight }) => {
            const binary = atob(picture.pixelsBase64);
            const canvas = document.createElement('canvas');
            canvas.width = picture.width;
            canvas.height = picture.height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Original screenshot artifact canvas is unavailable');
            const rgba = context.createImageData(picture.width, picture.height);
            for (let pixel = 0; pixel < picture.width * picture.height; pixel++) {
              const value = binary.charCodeAt(pixel * 2) | (binary.charCodeAt(pixel * 2 + 1) << 8);
              const red = (value >>> 11) & 31,
                green = (value >>> 5) & 63,
                blue = value & 31;
              const offset = pixel * 4;
              rgba.data[offset] = (red << 3) | (red >>> 2);
              rgba.data[offset + 1] = (green << 2) | (green >>> 4);
              rgba.data[offset + 2] = (blue << 3) | (blue >>> 2);
              rgba.data[offset + 3] = 255;
            }
            context.putImageData(rgba, 0, 0);
            const full = document.createElement('canvas');
            full.width = Math.min(maxWidth, picture.width);
            full.height = Math.max(1, Math.round((picture.height * full.width) / picture.width));
            const fullContext = full.getContext('2d');
            const crop = document.createElement('canvas');
            crop.width = cropWidth;
            crop.height = cropHeight;
            const cropContext = crop.getContext('2d');
            if (!fullContext || !cropContext) throw new Error('Native PNG artifact contexts are unavailable');
            fullContext.imageSmoothingEnabled = false;
            cropContext.imageSmoothingEnabled = false;
            fullContext.drawImage(canvas, 0, 0, full.width, full.height);
            cropContext.drawImage(canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, crop.width, crop.height);
            return {
              full: full.toDataURL('image/png'),
              crop: crop.toDataURL('image/png'),
              fullSize: { width: full.width, height: full.height },
            };
          },
          { picture: native, rect: hd.rect, maxWidth: MAX_WIDTH, cropWidth: hd.width, cropHeight: hd.height },
        );
        const artifactNames = {
          hd: `${prefix}-same-frame-HD.png`,
          original: `${prefix}-same-frame-original.png`,
          originalTactical: `${prefix}-same-frame-original-tactical.png`,
        };
        for (const [name, data] of [
          ['hd', hd.png],
          ['original', pngs.full],
          ['originalTactical', pngs.crop],
        ]) {
          if (!data.startsWith('data:image/png;base64,')) throw new Error('Screenshot artifact was not a PNG');
          const path = join(directory, artifactNames[name]);
          await writeFile(path, Buffer.from(data.slice(data.indexOf(',') + 1), 'base64'));
          report.artifacts[name] = path;
        }
        report.met = true;
        attempt.matched = true;
        report.pair = {
          hdFrame: hd.frame,
          originalFrame: native.frame,
          hdShownDuringCapture: hd.shown,
          hdDrawAtMs: hd.drawAtMs,
          nativePictureAtMs: native.atMs,
          map: hd.map,
          view: hd.view,
          tacticalRect: hd.rect,
          comparisonSize: { width: hd.width, height: hd.height },
          originalSize: pngs.fullSize,
          nativeKeyPixels: native.keyPixels,
          nativeKeyPixelRatio: native.keyPixelRatio,
          hdVisibleSamples: hd.visibleSamples,
          hdColours: hd.colours,
          combat: hd.combat,
          captureMode: report.configuration.mode,
          actualPassthroughAtDraw: hd.passthrough,
          passthroughObservations: hd.passthroughObservations,
          sourceHdSize: hd.sourceSize,
          hdGpuFormat: hd.format,
          hdCaptureMethod: hd.captureMethod,
          provenance: 'actual completed HD browser canvas draw and delivered native RGB565 at the same logic frame',
          posePolicy: 'normal live interpolation; capture never forces positions or redraws the HD scene',
          scope: captureWithoutSwitch
            ? 'Alternate visual-only HD canvas and complete original tactical crop; native UI overlays are excluded from the HD canvas and this mode cannot establish owner-mode overlay acceptance'
            : 'HD canvas and original tactical crop; original full picture retained for native UI, not an invented HD overlay',
        };
        await emit('same-frame-pair-captured', report.pair);
      }
      await setHd(true);
      await delay(150);
      await emit('same-frame-pair-attempt', attempt);
    }
    if (!report.met)
      report.error = captureWithoutSwitch
        ? 'No complete non-keyed native picture matched an enabled HD draw frame in eight natural visual-only capture windows'
        : 'No complete non-keyed native picture matched an actual HD draw frame in eight real Backslash attempts';
  } catch (error) {
    report.met = false;
    report.error = String(error.stack ?? error);
  } finally {
    try {
      report.shortCapture = await page.evaluate(() => window.__hdBridge?.diagnostics?.finishCapture() ?? null);
    } catch (error) {
      report.cleanup.captureError = String(error);
    }
    try {
      await setHd(true);
      report.cleanup.hdRestored = true;
    } catch (error) {
      report.cleanup.hdError = String(error);
    }
    if (installed) {
      try {
        report.observerFinal = await agent.evaluate(
          ({ slot, owner }) => {
            const capture = globalThis[slot];
            if (!capture || capture.owner !== owner) throw new Error('Native observer owner missing at cleanup');
            const summary = { copied: capture.copied, retained: capture.ring.length, errors: capture.errors };
            capture.stop();
            delete globalThis[slot];
            return summary;
          },
          { slot: SLOT, owner },
        );
        report.cleanup.unsubscribed = true;
      } catch (error) {
        report.cleanup.unsubscribeError = String(error);
      }
    }
    if (!report.cleanup.hdRestored || (installed && !report.cleanup.unsubscribed)) report.met = false;
    report.finishedAt = new Date().toISOString();
    report.reportPath = reportPath;
    await mkdir(directory, { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2));
  }
  return report;
}
