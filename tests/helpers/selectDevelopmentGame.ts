import { localizeText, type UiLocale } from '../../src/ui/shared/i18n/translate';
import { expect, type Page } from '@playwright/test';
import { SUPPORTED_GAMES } from '../../src/games/catalog';

/** Locate games by accessible name, avoiding dependence on icons, skins, or button order. */
export function detectedGameButton(page: Page, game: string, locale: UiLocale = 'zh-CN') {
  const entry = SUPPORTED_GAMES.find((entry) => entry.id === game);
  if (!entry) throw new Error('仅支持 ra2 或 yr');
  return page.locator('.detected-games').getByRole('button', { name: localizeText(entry.title, locale), exact: true });
}

/** Single-game resources start automatically; with multiple games, select by name rather than button position. */
export async function selectDevelopmentGame(page: Page, game: string): Promise<void> {
  if (game !== 'ra2' && game !== 'yr') throw new Error('仅支持 ra2 或 yr');
  await page.getByRole('button', { name: '开发测试', exact: true }).click();
  await page.waitForFunction(
    () => {
      const picker = document.querySelector('.game-source-picker');
      const error = picker?.querySelector<HTMLElement>('[role="alert"]');
      return (
        !picker ||
        picker.getClientRects().length === 0 ||
        !!picker.querySelector('.detected-games button') ||
        (!!error && !error.hidden && !!error.textContent)
      );
    },
    null,
    { timeout: 120000 },
  );
  await expect(page.locator('.source-picker-error:visible')).toHaveCount(0);
  if (await page.locator('.detected-games button').count()) {
    await detectedGameButton(page, game).click();
  }
}
