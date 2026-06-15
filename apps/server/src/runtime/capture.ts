import type { Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { collectDomTargets } from './dom-targets.js';

export type CaptureResult = {
  screenshotPath: string;
  domTargetsPath: string;
  metadataPath: string;
  imageSize: { width: number; height: number };
  scroll: { x: number; y: number };
  domTargets: unknown[];
};

export async function capturePage(options: {
  page: Page;
  dataDir: string;
  captureId: string;
  mode: 'viewport' | 'fullPage';
  metadata: Record<string, unknown>;
}): Promise<CaptureResult> {
  const captureDir = join(options.dataDir, 'captures', options.captureId);
  await mkdir(captureDir, { recursive: true });
  const screenshotPath = join(captureDir, 'screenshot.png');
  const domTargetsPath = join(captureDir, 'dom-targets.json');
  const metadataPath = join(captureDir, 'metadata.json');

  const buffer = await options.page.screenshot({ path: screenshotPath, fullPage: options.mode === 'fullPage', scale: 'css' });
  const png = PNG.sync.read(buffer);
  const scroll = await options.page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  const domTargets = await collectDomTargets(options.page, options.mode);
  const metadata = {
    ...options.metadata,
    mode: options.mode,
    scroll,
    imageSize: { width: png.width, height: png.height }
  };

  await writeFile(domTargetsPath, JSON.stringify(domTargets, null, 2));
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  return { screenshotPath, domTargetsPath, metadataPath, imageSize: metadata.imageSize, scroll, domTargets };
}
