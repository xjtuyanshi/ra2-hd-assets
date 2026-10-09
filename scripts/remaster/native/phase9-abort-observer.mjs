import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { outputDirectory, writePng } from './artifacts.mjs';

// Observe only the raster already delivered to the real renderer. The injected
// callback owns the real Yes click; this helper never requests or forces paint.
export async function observePhase9Abort({ page, clickYes, out, record = async () => {}, label = 'abort' }) {
  assert.equal(typeof clickYes, 'function');
  assert(/^[a-zA-Z0-9_-]+$/.test(label));
  out = outputDirectory(out);
  await mkdir(out, { recursive: true });
  const installed = await page.evaluate(
    ({ label }) => {
      const presentation = window.__phase7Presentation;
      if (!presentation?.draw) throw new Error('Actual backend draw observer is required');
      if (window.__phase9AbortProbe) throw new Error('Abort observer already installed');
      const now = () => performance.timeOrigin + performance.now();
      const startedAt = now();
      const probe = {
        label,
        startedAt,
        endAt: startedAt + 8000,
        clickStartedAt: null,
        clickEndedAt: null,
        pointerEvents: [],
        rendererDraws: 0,
        nativeRasterDraws: 0,
        distinctFrameObjects: 0,
        invalidRasterDraws: 0,
        frames: [],
        captures: [],
        captureBytes: 0,
        droppedSnapshots: 0,
        droppedFrameRecords: 0,
        lastDimensions: null,
        nextSampleAt: null,
        lastFrame: null,
        seen: new Uint32Array(65536),
        inspectionTotalMs: 0,
        inspectionMaxMs: 0,
        active: true,
      };
      const original = presentation.draw;
      const wrapped = function (args) {
        const result = original.call(this, args);
        const at = now();
        if (!probe.active || at > probe.endAt) return result;
        probe.rendererDraws++;
        const frame = args[0];
        if (!frame?.rgb565) return result;
        const { width, height, rgb565 } = frame;
        const size = width * height;
        if (
          !Number.isInteger(width) ||
          !Number.isInteger(height) ||
          width <= 0 ||
          height <= 0 ||
          rgb565.length !== size
        ) {
          probe.invalidRasterDraws++;
          return result;
        }
        const inspectionStart = performance.now();
        const sequence = ++probe.nativeRasterDraws;
        const distinctFrameObject = frame !== probe.lastFrame;
        if (distinctFrameObject) probe.distinctFrameObjects++;
        probe.lastFrame = frame;
        let blackPixels = 0;
        let pureGreenPixels = 0;
        let distinctColours = 0;
        for (let i = 0; i < size; i++) {
          const colour = rgb565[i];
          if (colour === 0) blackPixels++;
          else if ((colour & 0xf81f) === 0) pureGreenPixels++;
          if (probe.seen[colour] !== sequence) {
            probe.seen[colour] = sequence;
            distinctColours++;
          }
        }
        const dimensionKey = `${width}x${height}`;
        const dimensionChanged = probe.lastDimensions !== null && dimensionKey !== probe.lastDimensions;
        const allSingleColour = distinctColours === 1;
        const item = {
          sequence,
          rendererDraw: probe.rendererDraws,
          at,
          sinceStartMs: at - probe.startedAt,
          sinceClickStartMs: probe.clickStartedAt === null ? null : at - probe.clickStartedAt,
          width,
          height,
          nativeFrameNumber: Number.isFinite(frame.frame) ? frame.frame : null,
          distinctFrameObject,
          dimensionChanged,
          pixelCount: size,
          blackPixels,
          pureGreenPixels,
          otherColourPixels: size - blackPixels - pureGreenPixels,
          distinctColours,
          allBlack: blackPixels === size,
          allPureGreen: pureGreenPixels === size,
          allBlackOrPureGreen: blackPixels + pureGreenPixels === size,
          allSingleColour,
          singleColourRgb565: allSingleColour ? rgb565[0] : null,
        };
        const reasons = [];
        if (sequence === 1) reasons.push('first-native-raster-draw');
        if (probe.nextSampleAt === null || at >= probe.nextSampleAt) {
          reasons.push('500ms-source-sample');
          probe.nextSampleAt ??= at;
          do {
            probe.nextSampleAt += 500;
          } while (probe.nextSampleAt <= at);
        }
        if (dimensionChanged) reasons.push('dimensions-changed');
        if (allSingleColour) reasons.push('all-single-colour');
        if (reasons.length) {
          // Uniform rasters have a lossless one-colour representation. This lets
          // every such real draw be saved without retaining duplicate megapixels.
          const bytes = allSingleColour ? 0 : rgb565.byteLength;
          if (probe.captureBytes + bytes <= 64 * 1024 * 1024) {
            const file = `${label}-frame-${String(sequence).padStart(5, '0')}.png`;
            item.snapshotFile = file;
            item.snapshotReasons = reasons;
            probe.captures.push({
              ...item,
              pixels: allSingleColour ? null : rgb565.slice(),
            });
            probe.captureBytes += bytes;
          } else {
            item.snapshotDropped = true;
            probe.droppedSnapshots++;
          }
        }
        probe.lastDimensions = dimensionKey;
        const inspectionMs = performance.now() - inspectionStart;
        item.inspectionMs = inspectionMs;
        probe.inspectionTotalMs += inspectionMs;
        probe.inspectionMaxMs = Math.max(probe.inspectionMaxMs, inspectionMs);
        if (probe.frames.length < 16384) probe.frames.push(item);
        else probe.droppedFrameRecords++;
        return result;
      };
      const pointer = (event) => {
        if (!probe.active || event.target?.id !== 'screen' || probe.pointerEvents.length >= 64) return;
        probe.pointerEvents.push({
          type: event.type,
          button: event.button,
          trusted: event.isTrusted,
          at: now(),
          eventAt: performance.timeOrigin + event.timeStamp,
        });
      };
      window.addEventListener('pointerdown', pointer, true);
      window.addEventListener('pointerup', pointer, true);
      presentation.draw = wrapped;
      probe.drain = () => {
        const captures = probe.captures.splice(0);
        probe.captureBytes = 0;
        return captures.map(({ pixels, ...item }) => {
          if (!pixels) return { ...item, pixels: null };
          const bytes = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 32768)
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
          return { ...item, pixels: btoa(binary) };
        });
      };
      probe.stop = () => {
        probe.active = false;
        window.removeEventListener('pointerdown', pointer, true);
        window.removeEventListener('pointerup', pointer, true);
        if (presentation.draw === wrapped) presentation.draw = original;
        if (window.__phase9AbortProbe === probe) delete window.__phase9AbortProbe;
        const { seen, captures, lastFrame, active, drain, stop, ...summary } = probe;
        return { ...summary, stoppedAt: now(), captures: probe.drain() };
      };
      window.__phase9AbortProbe = probe;
      return { startedAt: probe.startedAt, endAt: probe.endAt, durationMs: 8000 };
    },
    { label },
  );
  const savedFrames = [];
  const save = (captures) => {
    for (const { pixels, ...item } of captures) {
      const raster = pixels
        ? Buffer.from(pixels, 'base64')
        : Buffer.alloc(
            item.width * item.height * 2,
            Buffer.from([item.singleColourRgb565 & 255, item.singleColourRgb565 >>> 8]),
          );
      writePng(join(out, item.snapshotFile), { width: item.width, height: item.height, pixels: raster });
      savedFrames.push(item);
    }
  };
  let clickError = null;
  let observationError = null;
  let evidence = null;
  try {
    await page.evaluate(() => {
      window.__phase9AbortProbe.clickStartedAt = performance.timeOrigin + performance.now();
    });
    try {
      await clickYes();
    } catch (error) {
      clickError = String(error);
    }
    await page.evaluate(() => {
      window.__phase9AbortProbe.clickEndedAt = performance.timeOrigin + performance.now();
    });
    while (Date.now() < installed.endAt) {
      save(await page.evaluate(() => window.__phase9AbortProbe.drain()));
      await delay(Math.min(125, Math.max(1, installed.endAt - Date.now())));
    }
  } catch (error) {
    observationError = String(error);
  } finally {
    try {
      evidence = await page.evaluate(() => window.__phase9AbortProbe.stop());
      save(evidence.captures);
      delete evidence.captures;
    } catch (error) {
      observationError ??= String(error);
    }
  }
  const proof = {
    label,
    ...installed,
    ...evidence,
    clickError,
    observationError,
    savedFrames,
    classification: {
      black: 'Exact RGB565 value 0x0000.',
      pureGreen: 'Red and blue channels exactly zero, green channel nonzero; no similarity threshold.',
      otherColour: 'Every remaining RGB565 pixel. This is a pixel category, not proof of a complete playable image.',
      singleColour: 'Every source pixel is exactly equal. PNG reconstruction from the one-colour value is lossless.',
    },
    interpretation:
      'Counts are actual backend renderer draws and valid RGB565 draws during the eight-second window. Distinct frame-object counts identify object identity only. Observer pixel classification/copy costs are recorded; this does not measure physical scanout or set any acceptance threshold.',
  };
  await writeFile(join(out, label + '-frames.json'), JSON.stringify(proof, null, 2));
  await record('abort-native-frame-observation', {
    label,
    file: label + '-frames.json',
    rendererDraws: proof.rendererDraws ?? null,
    nativeRasterDraws: proof.nativeRasterDraws ?? null,
    snapshots: savedFrames.length,
    allBlackDraws: proof.frames?.filter((item) => item.allBlack).length ?? null,
    allPureGreenDraws: proof.frames?.filter((item) => item.allPureGreen).length ?? null,
    allSingleColourDraws: proof.frames?.filter((item) => item.allSingleColour).length ?? null,
    dimensionChanges: proof.frames?.filter((item) => item.dimensionChanged).length ?? null,
    droppedSnapshots: proof.droppedSnapshots ?? null,
    clickError,
    observationError,
  });
  return proof;
}
