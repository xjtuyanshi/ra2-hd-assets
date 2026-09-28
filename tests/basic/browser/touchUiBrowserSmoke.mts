import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';
/** No game assets: switch UI through real touch/mouse events without mistaking touch capability for a mobile device. */
import { chromium, expect } from '@playwright/test';

const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 844, height: 390 },
    { width: 390, height: 844 },
  ]) {
    // Keep the desktop UA while enabling touch to reproduce a coarse=true desktop/emulator environment.
    const context = await browser.newContext({
      locale: 'zh-CN',
      ignoreHTTPSErrors: true,
      hasTouch: true,
      isMobile: false,
      viewport,
    });
    try {
      const page = await context.newPage();
      await preventThirdPartyDownloads(page);
      await page.goto(origin);
      await page.getByRole('button', { name: '选择文件…', exact: true }).waitFor();
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
      await page.evaluate(async () => {
        const controlsUrl = '/src/ui/pages/game/touchControls.ts';
        const inputUrl = '/src/ui/pages/game/gameInput.ts';
        const toolbarUrl = '/src/ui/pages/game/runtimeToolbar.ts';
        const stateUrl = '/src/ui/pages/game/state/uiState.ts';
        const { cancelSourceRequest } = await import(stateUrl);
        cancelSourceRequest();
        const { installAdaptiveTouchControls } = (await import(
          controlsUrl
        )) as typeof import('../../../src/ui/pages/game/touchControls');
        const { installGameInput } = (await import(inputUrl)) as typeof import('../../../src/ui/pages/game/gameInput');
        const { installRuntimeToolbar } = (await import(
          toolbarUrl
        )) as typeof import('../../../src/ui/pages/game/runtimeToolbar');
        const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
        document.body.classList.add('game-running');
        document.getElementById('ui')!.hidden = true;
        const vm = { setCursorPosition() {}, setKeyState() {}, postMessage() {} };
        const input = installGameInput(canvas, vm as unknown as import('../../../src/adapter/runtime').VmShell, false);
        const touch = installAdaptiveTouchControls(canvas, vm);
        const toolbar = installRuntimeToolbar(
          {
            onClockRate() {},
            onVolume() {},
            onPerformance() {},
            onSendCheatText() {},
            onSendCheatKey() {},
            async onResolution() {},
            async onChangeSource() {},
            async onDownloadSave() {},
            async onUploadSave() {
              return false;
            },
          },
          canvas,
          'Canvas 2D',
          '触屏 UI 回归',
        );
        Object.assign(window, {
          cleanupTouchUi() {
            touch();
            input.cleanup();
            toolbar.destroy();
          },
        });
      });

      const controls = page.locator('#vm-touch-controls');
      const joystick = page.locator('#vm-touch-joystick');
      const rail = page.locator('#vm-controls');
      const canvas = page.locator('#screen');
      await expect(controls).toBeHidden();
      await expect(joystick).toBeHidden();
      await expect(rail).not.toHaveClass(/collapsed/);

      const box = await canvas.boundingBox();
      if (!box) throw new Error('测试画布不可见');
      const x = Math.min(viewport.width - 130, box.x + box.width * 0.6);
      const y = Math.min(viewport.height - 150, box.y + box.height * 0.4);
      await page.mouse.click(x, y);
      await expect(controls).toBeHidden();
      await expect(rail).not.toHaveClass(/collapsed/);

      await page.touchscreen.tap(x, y);
      await expect(controls).toBeVisible();
      await expect(joystick).toBeVisible();
      await expect(rail).toHaveClass(/collapsed/);
      await page.locator('#vm-touch-controls [data-role="collapse"]').tap();
      await expect(controls).toHaveClass(/collapsed/);

      await page.mouse.move(x + 10, y + 10);
      await expect(controls).toBeHidden();
      await expect(joystick).toBeHidden();
      await page.touchscreen.tap(x, y);
      await expect(controls).toBeVisible();
      await expect(controls).toHaveClass(/collapsed/);
      await page.evaluate(() => (window as unknown as { cleanupTouchUi(): void }).cleanupTouchUi());
      await page.touchscreen.tap(x, y);
      await expect(controls).toBeHidden();
      await expect(joystick).toBeHidden();
      console.log(`${viewport.width}×${viewport.height}：coarse 能力不切换 UI，实际触摸/鼠标切换与清理通过`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
