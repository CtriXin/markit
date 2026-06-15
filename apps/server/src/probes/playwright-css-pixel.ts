import { chromium, type BrowserContextOptions } from 'playwright';
import { PNG } from 'pngjs';

type ProbeCase = {
  name: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile?: boolean;
};

const cases: ProbeCase[] = [
  { name: 'desktop-dsf1', viewport: { width: 320, height: 240 }, deviceScaleFactor: 1 },
  { name: 'desktop-dsf2', viewport: { width: 320, height: 240 }, deviceScaleFactor: 2 },
  { name: 'mobile-dsf3', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true }
];

const html = `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { margin: 0; width: 100%; min-height: 1200px; background: #ffffff; }
      #probe-box { position: absolute; left: 23px; top: 17px; width: 137px; height: 91px; background: #ff0000; }
    </style>
  </head>
  <body><div id="probe-box"></div></body>
</html>`;

function readPng(buffer: Buffer): PNG {
  return PNG.sync.read(buffer);
}

function pixelAt(png: PNG, x: number, y: number): [number, number, number, number] {
  const index = (png.width * y + x) << 2;
  return [png.data[index] ?? 0, png.data[index + 1] ?? 0, png.data[index + 2] ?? 0, png.data[index + 3] ?? 0];
}

function isRed(pixel: [number, number, number, number]) {
  const [r, g, b, a] = pixel;
  return r > 240 && g < 20 && b < 20 && a === 255;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function runProbe() {
  const browser = await chromium.launch();
  try {
    for (const probe of cases) {
      const contextOptions: BrowserContextOptions = {
        viewport: probe.viewport,
        deviceScaleFactor: probe.deviceScaleFactor,
        isMobile: probe.isMobile ?? false
      };
      const context = await browser.newContext(contextOptions);
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });

      const rect = await page.locator('#probe-box').boundingBox();
      assert(rect, `${probe.name}: probe box missing`);
      assert(Math.abs(rect.x - 23) < 0.5, `${probe.name}: rect.x drifted`);
      assert(Math.abs(rect.y - 17) < 0.5, `${probe.name}: rect.y drifted`);
      assert(Math.abs(rect.width - 137) < 0.5, `${probe.name}: rect.width drifted`);
      assert(Math.abs(rect.height - 91) < 0.5, `${probe.name}: rect.height drifted`);

      const viewportPng = readPng(await page.screenshot({ scale: 'css', fullPage: false }));
      assert(viewportPng.width === probe.viewport.width, `${probe.name}: viewport width ${viewportPng.width}`);
      assert(viewportPng.height === probe.viewport.height, `${probe.name}: viewport height ${viewportPng.height}`);
      assert(isRed(pixelAt(viewportPng, 23, 17)), `${probe.name}: red area start not sampled`);
      assert(isRed(pixelAt(viewportPng, 159, 107)), `${probe.name}: red area end not sampled`);
      assert(!isRed(pixelAt(viewportPng, 22, 16)), `${probe.name}: outside edge sampled as red`);

      const fullPagePng = readPng(await page.screenshot({ scale: 'css', fullPage: true }));
      assert(fullPagePng.width === probe.viewport.width, `${probe.name}: fullPage width ${fullPagePng.width}`);
      assert(fullPagePng.height >= 1200, `${probe.name}: fullPage height ${fullPagePng.height}`);
      await context.close();
      console.log(`pixel probe pass: ${probe.name}`);
    }
  } finally {
    await browser.close();
  }
}

runProbe().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
