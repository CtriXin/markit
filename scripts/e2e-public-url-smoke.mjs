#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const evidenceDir = path.join(root, '.agent.local', 'evidence', 'public-url-smoke');
const dataDir = path.join(evidenceDir, '.markit');
const appUrl = 'http://127.0.0.1:5173';
const apiUrl = 'http://127.0.0.1:4317';
const targetUrl = process.env.MARKIT_PUBLIC_TEST_URL || 'https://example.com/';
const children = [];
const logs = [];

async function main() {
  await rm(evidenceDir, { recursive: true, force: true });
  await mkdir(evidenceDir, { recursive: true });
  startProcess('pnpm', ['dev'], { cwd: root, name: 'app', env: { ...process.env, MARKIT_AI_PROVIDER: 'mock', MARKIT_DATA_DIR: dataDir } });
  await waitForHttp(`${apiUrl}/api/health`, 'markit api');
  await waitForHttp(appUrl, 'markit web');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30_000);
  try {
    await page.goto(appUrl, { waitUntil: 'networkidle' });
    await page.getByTestId('url-input').fill(targetUrl);
    await page.getByTestId('viewport-select').selectOption('mobile-390');
    await page.getByTestId('open-session').click();
    await page.waitForSelector('[data-testid="device-mobile"] img');
    await page.waitForFunction(() => !document.querySelector('.mk-busy'));
    await page.screenshot({ path: path.join(evidenceDir, '01-public-url-single.png'), fullPage: true });
    const singleResult = await page.evaluate(() => {
      const addressInput = document.querySelector('[data-testid="session-address"]');
      return {
        address: addressInput && 'value' in addressInput ? String(addressInput.value) : '',
        hasPc: Boolean(document.querySelector('[data-testid="device-pc"] img')),
        hasMobile: Boolean(document.querySelector('[data-testid="device-mobile"] img')),
        hasCanvas: Boolean(document.querySelector('[data-testid="canvas-layer"] img')),
        visibleText: document.body.innerText.slice(0, 1000)
      };
    });
    if (!singleResult.address?.startsWith(new URL(targetUrl).origin)) throw new Error(`Address did not navigate to target: ${singleResult.address}`);
    if (singleResult.hasPc || !singleResult.hasMobile || !singleResult.hasCanvas) throw new Error(`Expected single mobile frame: ${JSON.stringify(singleResult)}`);

    await page.getByTestId('preview-dual').click();
    await page.waitForSelector('[data-testid="device-pc"] img');
    await page.waitForSelector('[data-testid="device-mobile"] img');
    await page.waitForFunction(() => !document.querySelector('.mk-busy'));
    await page.screenshot({ path: path.join(evidenceDir, '02-public-url-dual-optional.png'), fullPage: true });
    const dualResult = await page.evaluate(() => ({
      hasPc: Boolean(document.querySelector('[data-testid="device-pc"] img')),
      hasMobile: Boolean(document.querySelector('[data-testid="device-mobile"] img')),
      modeText: document.querySelector('[data-testid="preview-dual"]')?.className || '',
      visibleText: document.body.innerText.slice(0, 1000)
    }));
    if (!dualResult.hasPc || !dualResult.hasMobile) throw new Error(`Missing optional dual frames: ${JSON.stringify(dualResult)}`);
    await writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify({ ok: true, targetUrl, singleResult, dualResult, screenshots: ['01-public-url-single.png', '02-public-url-dual-optional.png'] }, null, 2));
  } finally {
    await browser.close();
    stopChildren();
    await Promise.allSettled(children.map((child) => onceExit(child.proc)));
    await writeFile(path.join(evidenceDir, 'process.log'), logs.join(''));
  }
}

async function waitForHttp(url, label) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 45_000) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError?.message || lastError}`);
}

function startProcess(command, args, options) {
  const proc = spawn(command, args, { cwd: options.cwd, env: options.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const entry = { proc, name: options.name };
  children.push(entry);
  proc.stdout.on('data', (chunk) => pushLog(options.name, chunk));
  proc.stderr.on('data', (chunk) => pushLog(options.name, chunk));
  proc.on('exit', (code, signal) => pushLog(options.name, `exit code=${code} signal=${signal}\n`));
  return proc;
}

function pushLog(name, chunk) {
  logs.push(`[${name}] ${String(chunk)}`);
  if (logs.length > 300) logs.shift();
}

function stopChildren() {
  for (const child of children) {
    if (!child.proc.killed) child.proc.kill('SIGTERM');
  }
}

function onceExit(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode) resolve();
    else proc.once('exit', resolve);
    setTimeout(resolve, 5_000);
  });
}

process.on('SIGINT', () => { stopChildren(); process.exit(130); });
process.on('SIGTERM', () => { stopChildren(); process.exit(143); });

main().catch(async (error) => {
  try { await writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify({ ok: false, targetUrl, error: error instanceof Error ? error.stack || error.message : String(error) }, null, 2)); } catch {}
  stopChildren();
  console.error(error);
  process.exit(1);
});
