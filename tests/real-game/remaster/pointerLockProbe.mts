/**
 * Remaster phase-1 diagnostic: does a real mouse click on the YR main menu acquire Pointer Lock in this headless
 * Chromium? Prints console warnings so a browser rejection can be told apart from the page never requesting a lock.
 * Usage: RA2_BROWSER_ORIGIN=... [PROBE_CHANNEL=chromium] pnpm exec tsx tests/real-game/remaster/pointerLockProbe.mts
 */
import { chromium } from '@playwright/test';
import { selectDevelopmentGame } from '../../helpers/selectDevelopmentGame';

const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const channel = process.env.PROBE_CHANNEL;
const executablePath = process.env.RA2_BROWSER_EXECUTABLE;
const browser = await chromium.launch({
  ...(channel ? { channel } : {}),
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  const messages: string[] = [];
  page.on('console', (m) => {
    if (/lock|锁定/i.test(m.text())) messages.push(`${m.type()}: ${m.text()}`);
  });
  await page.goto(`${origin}/?debug=1`);
  await selectDevelopmentGame(page, 'yr');
  await page.waitForFunction(
    () => /mainmenu/i.test(document.querySelector<HTMLElement>('#screen')?.dataset.shellPage ?? ''),
    null,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(5_000);
  if (process.env.PROBE_FRONT === '1') {
    await page.bringToFront();
    await page.evaluate(() => window.focus());
  }
  const focus = await page.evaluate(() => ({ hasFocus: document.hasFocus(), visibility: document.visibilityState }));
  const box = (await page.locator('#screen').boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.8);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(1_500);
  const locked = await page.evaluate(() => document.pointerLockElement?.id ?? null);
  console.log(
    JSON.stringify({
      browser: browser.version(),
      channel: channel ?? 'headless-shell',
      front: process.env.PROBE_FRONT === '1',
      focus,
      locked,
      messages,
    }),
  );
} finally {
  await browser.close();
}
