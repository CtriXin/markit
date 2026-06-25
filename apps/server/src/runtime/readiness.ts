import type { Page } from 'playwright';

const DEFAULT_FONT_READY_TIMEOUT_MS = 2_500;
const POST_FONT_PAINT_DELAY_MS = 80;

export async function waitForPageFonts(page: Page, timeoutMs = DEFAULT_FONT_READY_TIMEOUT_MS): Promise<void> {
  await page.evaluate(async (fontTimeoutMs) => {
    const fonts = document.fonts;
    if (!fonts?.ready) return;

    await Promise.race([
      fonts.ready.catch(() => undefined),
      new Promise((resolve) => window.setTimeout(resolve, fontTimeoutMs))
    ]);

    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    });
  }, timeoutMs).catch(() => undefined);

  await page.waitForTimeout(POST_FONT_PAINT_DELAY_MS).catch(() => undefined);
}
