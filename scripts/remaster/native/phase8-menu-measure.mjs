import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

// This observer is injected into the page. It only copies pixels during the real backend draw.
export function installMenuRasterProbe() {
  const now = () => performance.timeOrigin + performance.now();
  const probe = {
    draws: 0,
    latest: null,
    captureRect: null,
    captures: [],
    active: null,
    lastPointerMove: null,
    draw(args) {
      const frame = args[0];
      if (!frame?.width || !frame?.height) return;
      const at = now();
      const pixel = (x, y) => {
        const i = y * frame.width + x;
        if (frame.rgb565) return frame.rgb565[i];
        const p = frame.rgba ? i * 4 : (frame.pixels[i] ?? 0) * 4;
        const source = frame.rgba ?? frame.palette;
        return ((source[p] >> 3) << 11) | ((source[p + 1] >> 2) << 5) | (source[p + 2] >> 3);
      };
      const samples = [];
      for (let y = 0; y < frame.height; y += 16)
        for (let x = 0; x < frame.width; x += 16) samples.push([x, y, pixel(x, y)]);
      this.latest = { width: frame.width, height: frame.height, at, samples };
      this.draws++;
      if (this.captureRect) {
        const [x0, y0, x1, y1] = this.captureRect;
        const pixels = [];
        for (let y = Math.max(0, y0); y < Math.min(frame.height, y1); y++)
          for (let x = Math.max(0, x0); x < Math.min(frame.width, x1); x++) pixels.push([x, y, pixel(x, y)]);
        this.captures.push({ at, width: frame.width, height: frame.height, pixels });
        if (this.captures.length > 2) this.captures.shift();
      }
      const active = this.active;
      if (!active || active.inputAt === null) return;
      let changed = 0;
      for (const [x, y, colour] of active.baseline) if (pixel(x, y) !== colour) changed++;
      const exact = active.template.pixels.every(([x, y, colour]) => pixel(x, y) === colour);
      active.draws.push({ at, changed, exact });
      if (active.draws.length > 512) active.draws.shift();
      if (changed && active.firstChangeDrawAt === null) {
        active.firstChangeDrawAt = at;
        requestAnimationFrame(() => (active.firstChangePresentationAt ??= now()));
      }
      if (exact && active.targetDrawAt === null) {
        active.targetDrawAt = at;
        requestAnimationFrame(() => (active.targetPresentationAt ??= now()));
      }
    },
  };
  window.__phase8MenuProbe = probe;
  window.addEventListener(
    'pointermove',
    (event) => {
      if (event.target?.id === 'screen')
        probe.lastPointerMove = { clientX: event.clientX, clientY: event.clientY, at: now() };
    },
    true,
  );
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (event.target?.id === 'screen' && probe.active) probe.active.inputAt ??= now();
    },
    true,
  );
}

export const phase8MenuRoutes = [
  { name: 'main-to-single', id: 1667, expected: 1401 },
  { name: 'single-to-skirmish', id: 1401, expected: 1559 },
  { name: 'skirmish-to-map', id: 1450, expected: 1733 },
  { name: 'map-to-skirmish', id: 1472, expected: 1559 },
  { name: 'skirmish-to-single', id: 1472, expected: 1401 },
  { name: 'single-to-main', id: 1670, expected: 1667 },
  { name: 'main-to-options', id: 1372, expected: 1486 },
  { name: 'options-to-main', id: 1670, expected: 1667 },
];

export const usableMenuControl = (control) =>
  control.visible && control.enabled && control.rect?.[2] > control.rect?.[0];

export async function calibrateMenuTemplate({ page, control, label, wait }) {
  await page.evaluate((rect) => {
    const probe = window.__phase8MenuProbe;
    probe.captureRect = rect;
    probe.captures = [];
  }, control.rect);
  await wait('two actual target ROI draws', () => page.evaluate(() => window.__phase8MenuProbe.captures.length === 2));
  await delay(400);
  const template = await page.evaluate(
    ({ control, label }) => {
      const probe = window.__phase8MenuProbe;
      const [a, b] = probe.captures;
      // Phase 7 used every pure-yellow game label pixel, not animated button backgrounds.
      // Learn each backend's own glyph positions while preserving that exact criterion.
      const pixels = a.pixels.filter((value, index) => value[2] === 0xffe0 && value[2] === b.pixels[index]?.[2]);
      probe.captureRect = null;
      probe.captures = [];
      return {
        expectedControlId: control.id,
        label,
        controlText: control.text,
        rect: control.rect,
        width: b.width,
        height: b.height,
        pixels,
        source: 'Exact pure-yellow RGB565 target label pixels copied during this backend real draw',
        sampledAt: [a.at, b.at],
      };
    },
    { control, label },
  );
  assert(template.pixels.length, 'Nonempty actual target raster required');
  return template;
}

export async function measureMenuRoute({ page, route, template, point, click, state, wait, ownerIdle }) {
  await ownerIdle();
  const before = await state();
  const control = before.controls.find((value) => usableMenuControl(value) && value.id === route.id);
  assert(control, 'Missing source control ' + route.id);
  const gamePoint = { x: (control.rect[0] + control.rect[2]) / 2, y: (control.rect[1] + control.rect[3]) / 2 };
  const [x, y] = await point(gamePoint.x, gamePoint.y);
  await page.mouse.move(x, y);
  await delay(100);
  await page.evaluate(
    ({ route, template, gamePoint }) => {
      const probe = window.__phase8MenuProbe;
      const current = probe.latest;
      if (current.width !== template.width || current.height !== template.height)
        throw new Error('Template dimensions mismatch');
      probe.captureRect = template.rect;
      probe.captures = [];
      probe.active = {
        route: route.name,
        template,
        baseline: current.samples.filter(
          ([x, y]) => Math.abs(x - gamePoint.x) >= 64 || Math.abs(y - gamePoint.y) >= 64,
        ),
        inputAt: null,
        firstChangeDrawAt: null,
        firstChangePresentationAt: null,
        targetDrawAt: null,
        targetPresentationAt: null,
        draws: [],
      };
    },
    { route, template, gamePoint },
  );
  await wait('source raster rejection', () => page.evaluate(() => window.__phase8MenuProbe.captures.length > 0));
  await page.evaluate(() => {
    const probe = window.__phase8MenuProbe;
    const captured = probe.captures.at(-1);
    const values = new Map(captured.pixels.map(([x, y, value]) => [y * captured.width + x, value]));
    if (probe.active.template.pixels.every(([x, y, value]) => values.get(y * captured.width + x) === value))
      throw new Error('Target raster already present before click');
    probe.captureRect = null;
    probe.captures = [];
  });
  const clickPose = await click(gamePoint.x, gamePoint.y);
  // Keep hover/cursor feedback outside the target control reference.
  const [neutralX, neutralY] = await point(400, 560);
  await page.mouse.move(neutralX, neutralY);
  const destination = await wait(
    'actual destination control ' + route.expected,
    async () => {
      const result = await state();
      return result.controls.some((value) => usableMenuControl(value) && value.id === route.expected) ? result : null;
    },
    20000,
  );
  const targetObservedAt = await page.evaluate(() => performance.timeOrigin + performance.now());
  await wait(
    'actual target raster presented',
    () => page.evaluate(() => window.__phase8MenuProbe.active.targetPresentationAt !== null),
    20000,
  );
  const evidence = await page.evaluate(() => {
    const probe = window.__phase8MenuProbe;
    const active = probe.active;
    const { template, baseline, ...result } = active;
    probe.active = null;
    return { ...result, templatePixels: template.pixels.length, baselinePixels: baseline.length };
  });
  return {
    ...evidence,
    expectedControlId: route.expected,
    clickPose,
    targetControlObservedAt: targetObservedAt,
    clickToTargetPictureMs: evidence.targetPresentationAt - evidence.inputAt,
    clickToFirstChangedPictureMs: evidence.firstChangePresentationAt - evidence.inputAt,
    actualDestination: destination,
    limitation:
      'Actual backend target control raster followed by the next rAF opportunity; page-side timing, not physical display scanout. Control existence is independently checked and never used to fabricate paint completion.',
  };
}

export function summarizeMenuRecords(records) {
  const stats = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    const q = (fraction) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
    return { n: sorted.length, p50: q(0.5), p95: q(0.95), min: sorted[0] ?? null, max: sorted.at(-1) ?? null };
  };
  return {
    targetPictureMs: stats(records.map((record) => record.clickToTargetPictureMs)),
    firstChangedPictureMs: stats(records.map((record) => record.clickToFirstChangedPictureMs)),
    byRoute: Object.fromEntries(
      phase8MenuRoutes.map((route) => [
        route.name,
        stats(records.filter((record) => record.route === route.name).map((record) => record.clickToTargetPictureMs)),
      ]),
    ),
  };
}
