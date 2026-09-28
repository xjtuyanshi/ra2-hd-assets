import { errors, type Page } from '@playwright/test';

/** Wait for the native main menu, dismissing full-install YR intros through normal page input. */
export async function waitForMainMenu(page: Page, game: string, timeout = 60_000): Promise<void> {
  const menuVisible = () =>
    /mainmenu/i.test(document.querySelector<HTMLCanvasElement>('#screen')?.dataset.shellPage ?? '');
  if (game !== 'yr') {
    await page.waitForFunction(menuVisible, null, { timeout });
    return;
  }

  // Match the Node save/load scenario's startup budget and one-second Escape retries.
  const startupTimeout = Math.max(timeout, 180_000);
  const deadline = Date.now() + startupTimeout;
  while (Date.now() < deadline) {
    try {
      await page.waitForFunction(menuVisible, null, { timeout: Math.max(1, Math.min(1000, deadline - Date.now())) });
      return;
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
    }
    // The normal game keyboard handler forwards keys only while the canvas has focus.
    await page.locator('#screen').focus();
    // Recheck after the timed wait to avoid a retry when the menu has just appeared.
    if (await page.evaluate(menuVisible)) return;
    if (Date.now() < deadline) await page.keyboard.press('Escape');
  }
  throw new Error(`YR main menu did not appear within ${startupTimeout}ms`);
}
