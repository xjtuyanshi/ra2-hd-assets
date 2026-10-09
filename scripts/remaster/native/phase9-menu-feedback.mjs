import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writePng } from './artifacts.mjs';
import { phase8MenuRoutes, usableMenuControl } from './phase8-menu-measure.mjs';

// This is a read-only observer of the frame already passed to backend.draw.
// It never paints local button feedback or changes native control state.
export async function installPhase9MenuFeedbackProbe(page) {
  return page.evaluate(() => {
    if (window.__phase9MenuFeedback) return { installed: true, reused: true };
    const presentation = window.__phase7Presentation;
    if (!presentation?.draw) throw new Error('Actual backend draw observer is required');
    const now = () => performance.timeOrigin + performance.now();
    const probe = {
      rect: null,
      captures: [],
      active: null,
      draw(args) {
        const frame = args[0];
        if (!frame?.rgb565 || !this.rect) return;
        const at = now();
        const [left, top, right, bottom] = this.rect;
        const width = right - left;
        const height = bottom - top;
        const pixels = new Uint16Array(width * height);
        for (let y = 0; y < height; y++)
          pixels.set(frame.rgb565.subarray((top + y) * frame.width + left, (top + y) * frame.width + right), y * width);
        const capture = { at, width, height, pixels };
        if (!this.active) {
          this.captures.push(capture);
          if (this.captures.length > 6) this.captures.shift();
          return;
        }
        const active = this.active;
        if (active.inputAt === null || at < active.inputAt) return;
        const changed = { label: 0, bevel: 0, interior: 0 };
        for (const sample of active.samples) if (pixels[sample.index] !== sample.colour) changed[sample.group]++;
        const record = { at, changed, pointerStillDown: active.upAt === null };
        active.draws.push(record);
        if (active.draws.length > 128) active.draws.shift();
        if (!active.firstChanged && changed.label + changed.bevel + changed.interior) {
          active.firstChanged = { ...record, presentationAt: null, pixels };
          active.firstFrame = { width: frame.width, height: frame.height, pixels: frame.rgb565.slice() };
          // This follows the real backend draw. It is a display opportunity,
          // not a claim about physical compositor/display scanout.
          requestAnimationFrame(() => (active.firstChanged.presentationAt ??= now()));
        }
      },
    };
    const original = presentation.draw;
    const wrapped = function (...args) {
      original.apply(this, args);
      probe.draw(args[0]);
    };
    presentation.draw = wrapped;
    const down = (event) => {
      if (event.target?.id !== 'screen' || event.button !== 0 || !probe.active) return;
      probe.active.inputAt ??= now();
      probe.active.eventTimeStampAt ??= performance.timeOrigin + event.timeStamp;
      probe.active.trusted = event.isTrusted;
    };
    const up = (event) => {
      if (event.target?.id === 'screen' && event.button === 0 && probe.active) probe.active.upAt ??= now();
    };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    probe.stop = () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      if (presentation.draw === wrapped) presentation.draw = original;
      delete window.__phase9MenuFeedback;
    };
    window.__phase9MenuFeedback = probe;
    return { installed: true, captureBound: 6, perClickDrawBound: 128 };
  });
}

const statistics = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const q = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return { n: sorted.length, p50: q(0.5), p95: q(0.95), min: sorted[0] ?? null, max: sorted.at(-1) ?? null };
};

export function summarizePhase9MenuFeedback(records) {
  return {
    clicks: records.length,
    trustedClicks: records.filter((value) => value.trusted).length,
    observedFirstReaction: records.filter((value) => Number.isFinite(value.eventToFirstReactionMs)).length,
    eventToFirstReactionMs: statistics(records.map((value) => value.eventToFirstReactionMs)),
    handlerToFirstReactionMs: statistics(records.map((value) => value.handlerToFirstReactionMs)),
    underOrEqual60Ms: records.filter(
      (value) => value.eventToFirstReactionMs <= 60 && value.eventToFirstReactionMs !== null,
    ).length,
    firstReactionWhileHeld: records.filter((value) => value.firstChanged?.pointerStillDown).length,
    byRoute: Object.fromEntries(
      phase8MenuRoutes.map((route) => [
        route.name,
        statistics(records.filter((value) => value.route === route.name).map((value) => value.eventToFirstReactionMs)),
      ]),
    ),
    buttonPressStateVerified: false,
    interpretation:
      'Exact first changed source-control art is saved for every click. Inspect those pictures before classifying the change as the real pressed state; animation/target control existence never automatically counts as button feedback. Following rAF is page-side evidence, not physical scanout.',
  };
}

export async function measurePhase9MenuFeedbackClick({
  page,
  route,
  point,
  state,
  wait,
  out,
  ownerIdle = async () => {},
  label = route.name,
  holdMs = 120,
}) {
  await ownerIdle();
  await installPhase9MenuFeedbackProbe(page);
  const source = await state();
  const control = source.controls.find((value) => usableMenuControl(value) && value.id === route.id);
  assert(control, 'Missing real source control ' + route.id);
  const rect = control.rect.map((value) => Math.round(value));
  // The left inner edge is a genuine hit inside the source button. Its cursor
  // exclusion leaves the middle/right label and frame pixels available.
  const gamePoint = { x: rect[0] + 10, y: Math.round((rect[1] + rect[3]) / 2) };
  const [x, y] = await point(gamePoint.x, gamePoint.y);
  await page.mouse.move(x, y);
  await delay(200);
  await page.evaluate((rect) => {
    const probe = window.__phase9MenuFeedback;
    probe.rect = rect;
    probe.captures = [];
    probe.active = null;
  }, rect);
  await wait('four real unpressed control draws', async () => {
    await ownerIdle();
    return page.evaluate(() => window.__phase9MenuFeedback.captures.length >= 4);
  });
  const baseline = await page.evaluate(
    ({ route, control, gamePoint }) => {
      const probe = window.__phase9MenuFeedback;
      const captures = probe.captures.slice(-4);
      const last = captures.at(-1);
      const [left, top, right, bottom] = probe.rect;
      const samples = [];
      for (let index = 0; index < last.pixels.length; index++) {
        const colour = last.pixels[index];
        if (!captures.every((value) => value.pixels[index] === colour)) continue;
        const x = left + (index % last.width);
        const y = top + Math.floor(index / last.width);
        // Exclude a conservative full authentic cursor extent, even when the
        // negotiated page-cursor path has suppressed the baked native cursor.
        if (Math.abs(x - gamePoint.x) <= 55 && Math.abs(y - gamePoint.y) <= 43) continue;
        const red = ((colour >>> 11) & 31) * 2;
        const green = (colour >>> 5) & 63;
        const blue = (colour & 31) * 2;
        const neutral = Math.max(red, green, blue) - Math.min(red, green, blue) <= 4;
        const border = x < left + 20 || x >= right - 20 || y < top + 9 || y >= bottom - 9;
        const group = colour === 0xffe0 ? 'label' : border && neutral ? 'bevel' : 'interior';
        samples.push({ index, colour, group });
      }
      if (!samples.some((value) => value.group === 'label')) throw new Error('No cursor-free stable real label pixels');
      probe.active = {
        route: route.name,
        sourceControlId: control.id,
        sourceHwnd: control.hwnd,
        samples,
        inputAt: null,
        eventTimeStampAt: null,
        upAt: null,
        trusted: null,
        firstChanged: null,
        firstFrame: null,
        draws: [],
      };
      const bytes = new Uint8Array(last.pixels.buffer);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      return {
        width: last.width,
        height: last.height,
        pixels: btoa(binary),
        rect: probe.rect,
        capturedAt: captures.map((value) => value.at),
        groupSamples: Object.fromEntries(
          ['label', 'bevel', 'interior'].map((group) => [group, samples.filter((v) => v.group === group).length]),
        ),
      };
    },
    { route, control, gamePoint },
  );
  await mkdir(out, { recursive: true });
  const prefix = join(out, label);
  writePng(prefix + '-unpressed-roi.png', { ...baseline, pixels: Buffer.from(baseline.pixels, 'base64') });
  await ownerIdle();
  await page.mouse.down({ button: 'left' });
  try {
    await delay(holdMs);
  } finally {
    await page.mouse.up({ button: 'left' });
  }
  // Readiness is used only to select the next real source control. The old
  // destination-route benchmark is intentionally not repeated here.
  await wait(
    'real destination ready ' + route.expected,
    async () => {
      await ownerIdle();
      return (await state()).controls.some((value) => usableMenuControl(value) && value.id === route.expected);
    },
    20000,
  );
  await delay(200);
  const evidence = await page.evaluate(() => {
    const probe = window.__phase9MenuFeedback;
    const active = probe.active;
    const encode = (value) => {
      if (!value) return null;
      const bytes = new Uint8Array(value.pixels.buffer);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      return { ...value, pixels: btoa(binary) };
    };
    const { samples, firstFrame, firstChanged, ...result } = active;
    probe.active = null;
    probe.rect = null;
    probe.captures = [];
    return { ...result, firstChanged: encode(firstChanged), firstFrame: encode(firstFrame) };
  });
  if (evidence.firstChanged)
    writePng(prefix + '-first-reaction-roi.png', {
      width: baseline.width,
      height: baseline.height,
      pixels: Buffer.from(evidence.firstChanged.pixels, 'base64'),
    });
  if (evidence.firstFrame)
    writePng(prefix + '-first-reaction-native.png', {
      ...evidence.firstFrame,
      pixels: Buffer.from(evidence.firstFrame.pixels, 'base64'),
    });
  const { firstFrame, firstChanged, ...compact } = evidence;
  const result = {
    ...compact,
    firstChanged: firstChanged
      ? {
          at: firstChanged.at,
          presentationAt: firstChanged.presentationAt,
          changed: firstChanged.changed,
          pointerStillDown: firstChanged.pointerStillDown,
        }
      : null,
    rect,
    gamePoint,
    browserPoint: { x, y },
    heldMs: evidence.upAt - evidence.inputAt,
    baseline: { ...baseline, pixels: undefined },
    eventToFirstReactionMs:
      firstChanged?.presentationAt != null ? firstChanged.presentationAt - evidence.eventTimeStampAt : null,
    handlerToFirstReactionMs:
      firstChanged?.presentationAt != null ? firstChanged.presentationAt - evidence.inputAt : null,
    evidenceFiles: [
      label + '-unpressed-roi.png',
      ...(firstChanged ? [label + '-first-reaction-roi.png', label + '-first-reaction-native.png'] : []),
    ],
    buttonPressStateVerified: false,
    interpretation:
      'First actual changed pixel among source-control art that was identical in four pre-click draws, excluding the authentic cursor extent. Retained exact frame must be visually checked to distinguish button pressed art from the start of native transition animation. No local button rendering, ACK, control existence or target label is used as paint proof.',
  };
  await writeFile(prefix + '-measurement.json', JSON.stringify(result, null, 2));
  return result;
}

export async function measurePhase9MenuFeedback({ page, point, state, wait, out, record, ownerIdle, count = 30 }) {
  assert(count === 30, 'Phase 9 requires exactly 30 measured menu clicks');
  await installPhase9MenuFeedbackProbe(page);
  const records = [];
  for (let index = 0; index < count; index++) {
    const route = phase8MenuRoutes[index % phase8MenuRoutes.length];
    const label = `menu-feedback-${String(index + 1).padStart(2, '0')}-${route.name}`;
    const result = await measurePhase9MenuFeedbackClick({ page, route, point, state, wait, out, ownerIdle, label });
    records.push(result);
    await record?.('menu-first-reaction', result);
  }
  const summary = summarizePhase9MenuFeedback(records);
  await writeFile(join(out, 'menu-feedback-summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(join(out, 'menu-feedback-records.json'), JSON.stringify(records, null, 2));
  await record?.('menu-first-reaction-summary', summary);
  return summary;
}
