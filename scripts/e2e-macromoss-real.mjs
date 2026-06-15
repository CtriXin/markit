#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const evidenceDir = path.join(root, '.agent.local', 'evidence', 'macromoss-real');
const dataDir = path.join(evidenceDir, '.markit');
const appUrl = 'http://127.0.0.1:5173';
const apiUrl = 'http://127.0.0.1:4317';
const targetUrl = process.env.MARKIT_MACROMOSS_URL || 'https://macromoss.com/';

const children = [];
const logs = [];
const result = {
  startedAt: new Date().toISOString(),
  targetUrl,
  screenshots: [],
  clickAttempts: [],
  capabilities: {},
  errors: []
};

async function main() {
  await rm(evidenceDir, { recursive: true, force: true });
  await mkdir(evidenceDir, { recursive: true });
  startProcess('pnpm', ['dev'], { cwd: root, name: 'app', env: { ...process.env, MARKIT_AI_PROVIDER: 'mock', MARKIT_DATA_DIR: dataDir } });
  await waitForHttp(`${apiUrl}/api/health`, 'markit api');
  await waitForHttp(appUrl, 'markit web');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(35_000);
  try {
    await page.goto(appUrl, { waitUntil: 'networkidle' });
    await page.getByTestId('url-input').fill(targetUrl);
    await page.getByTestId('viewport-select').selectOption('desktop-1440');
    await page.getByTestId('open-session').click();
    await page.waitForSelector('[data-testid="device-pc"] img');
    await waitIdle(page);
    await screenshot(page, '01-macromoss-single-pc.png');

    const initial = await page.evaluate(() => ({
      address: document.querySelector('[data-testid="session-address"]')?.value || '',
      hasPc: Boolean(document.querySelector('[data-testid="device-pc"] img')),
      hasMobile: Boolean(document.querySelector('[data-testid="device-mobile"] img')),
      text: document.body.innerText.slice(0, 1200)
    }));
    if (!initial.address.startsWith(new URL(targetUrl).origin)) throw new Error(`Macromoss did not load target origin: ${initial.address}`);
    if (!initial.hasPc || initial.hasMobile) throw new Error(`Expected default single PC preview: ${JSON.stringify(initial)}`);
    result.initial = initial;
    result.capabilities.realDomainRender = true;
    result.capabilities.singleDeviceDefault = true;

    const clickResult = await clickRealNavigation(page);
    result.capabilities.realClickNavigation = clickResult.afterUrl !== clickResult.beforeUrl;
    await screenshot(page, '02-macromoss-after-real-click.png');

    await verifyFreehand(page);
    result.capabilities.freehandCircle = true;
    await screenshot(page, '03-macromoss-circle-freehand.png');

    await verifySectionPick(page);
    result.capabilities.sectionPick = true;
    await screenshot(page, '04-macromoss-section-pick.png');

    await page.getByTestId('preview-dual').click();
    await page.waitForSelector('[data-testid="device-mobile"] img');
    await waitIdle(page);
    result.capabilities.optionalDualPreview = true;
    await screenshot(page, '05-macromoss-dual-optional.png');

    result.finishedAt = new Date().toISOString();
    await writeResult();
  } finally {
    await browser.close();
    stopChildren();
    await Promise.allSettled(children.map((child) => onceExit(child.proc)));
    await writeFile(path.join(evidenceDir, 'process.log'), logs.join(''));
  }
}

async function clickRealNavigation(page) {
  const tried = new Set();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const beforeCapture = await currentCaptureId(page);
    const beforeUrl = await addressValue(page);
    const targets = await currentTargets(page);
    const candidate = chooseLinkTarget(targets, tried);
    if (!candidate) break;
    tried.add(candidate.id);
    await setTool(page, 'browse');
    const point = await screenPoint(page, candidate.captureRect, 0.5, 0.5);
    await page.mouse.click(point.x, point.y);
    await waitForCaptureChange(page, beforeCapture);
    await waitIdle(page);
    const afterUrl = await addressValue(page);
    const record = {
      selector: candidate.selector,
      label: candidate.label,
      href: hrefFromHint(candidate.htmlHint),
      beforeUrl,
      afterUrl,
      changed: afterUrl !== beforeUrl
    };
    result.clickAttempts.push(record);
    if (record.changed) return record;
  }
  throw new Error(`No real link click changed URL. Attempts: ${JSON.stringify(result.clickAttempts, null, 2)}`);
}

async function verifyFreehand(page) {
  const target = chooseSectionTarget(await currentTargets(page));
  if (!target) throw new Error('No target available for freehand circle');
  const beforeCount = await annotationCount(page);
  await page.getByTestId('bug-comment').fill('圈画验证：真实网页区域可自由圈画');
  await setTool(page, 'freehand');
  await drawLoop(page, target.captureRect);
  await page.waitForFunction((count) => document.querySelectorAll('.mk-ann-list article').length > count, beforeCount);
}

async function verifySectionPick(page) {
  const target = chooseSectionTarget(await currentTargets(page));
  if (!target) throw new Error('No section-like target available');
  const beforeCount = await annotationCount(page);
  await page.getByTestId('bug-comment').fill('区块验证：点击后选中完整 section/card 区域');
  await setTool(page, 'section');
  const point = await screenPoint(page, target.captureRect, 0.5, 0.5);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction((count) => document.querySelectorAll('.mk-ann-list article').length > count, beforeCount);
  const lastText = await page.locator('.mk-ann-list article').last().innerText();
  if (!/区块/.test(lastText)) throw new Error(`Last annotation is not section: ${lastText}`);
  result.sectionTarget = { selector: target.selector, label: target.label, tagName: target.tagName };
}

function chooseLinkTarget(targets, tried) {
  return targets
    .filter((target) => target.tagName === 'a' && !tried.has(target.id))
    .map((target) => ({ target, href: hrefFromHint(target.htmlHint) }))
    .filter(({ target, href }) => href && !target.htmlHint.includes('target="_blank"') && !/^(#|mailto:|tel:|javascript:)/i.test(href))
    .sort((a, b) => linkScore(b.target, b.href) - linkScore(a.target, a.href))
    .map(({ target }) => target)[0];
}

function linkScore(target, href) {
  let score = 0;
  if (href.startsWith('/') || href.startsWith(targetUrl)) score += 100;
  if (/about|work|case|service|product|blog|contact/i.test(href)) score += 40;
  if (target.captureRect.y > 48 && target.captureRect.y < 780) score += 20;
  score += Math.min(30, target.captureRect.width / 10);
  return score;
}

function chooseSectionTarget(targets) {
  const rank = { article: 1, section: 2, main: 3, form: 4, aside: 5, nav: 6, header: 7, footer: 7 };
  return targets
    .filter((target) => rank[target.tagName] || (target.captureRect.width > 260 && target.captureRect.height > 120))
    .sort((a, b) => (rank[a.tagName] ?? 20) - (rank[b.tagName] ?? 20) || area(b.captureRect) - area(a.captureRect))[0];
}

function hrefFromHint(htmlHint) {
  const match = String(htmlHint || '').match(/\shref=["']([^"']+)["']/i);
  return match?.[1] || '';
}

async function drawLoop(page, rect) {
  const fractions = [
    [0.18, 0.52],
    [0.35, 0.18],
    [0.67, 0.18],
    [0.86, 0.52],
    [0.66, 0.84],
    [0.34, 0.84],
    [0.18, 0.52]
  ];
  const points = [];
  for (const [fx, fy] of fractions) points.push(await screenPoint(page, rect, fx, fy));
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 6 });
  await page.mouse.up();
}

async function setTool(page, tool) {
  await page.getByTestId(`tool-${tool}`).click();
  await page.waitForSelector(`[data-testid="tool-${tool}"].is-active`);
}

async function currentTargets(page) {
  const captureId = await currentCaptureId(page);
  const response = await fetch(`${apiUrl}/api/captures/${captureId}/dom-targets`);
  if (!response.ok) throw new Error(`dom-targets failed: ${response.status}`);
  return response.json();
}

async function currentCaptureId(page) {
  const src = await page.locator('[data-testid="canvas-layer"] img').getAttribute('src');
  const match = src?.match(/\/api\/captures\/([^/]+)\/image/);
  if (!match) throw new Error(`Cannot parse capture id from ${src}`);
  return match[1];
}

async function screenPoint(page, rect, fx, fy) {
  const img = page.locator('[data-testid="canvas-layer"] img');
  await img.waitFor();
  const box = await img.boundingBox();
  if (!box) throw new Error('Canvas image has no bounding box');
  const natural = await img.evaluate((node) => ({ width: node.naturalWidth, height: node.naturalHeight }));
  const captureX = Math.min(natural.width - 2, Math.max(2, rect.x + rect.width * fx));
  const captureY = Math.min(natural.height - 2, Math.max(2, rect.y + rect.height * fy));
  return {
    x: box.x + (captureX / natural.width) * box.width,
    y: box.y + (captureY / natural.height) * box.height
  };
}

async function waitForCaptureChange(page, previousId) {
  await page.waitForFunction((oldId) => {
    const src = document.querySelector('[data-testid="canvas-layer"] img')?.getAttribute('src') || '';
    const match = src.match(/\/api\/captures\/([^/]+)\/image/);
    return match && match[1] !== oldId;
  }, previousId);
}

async function annotationCount(page) {
  return page.locator('.mk-ann-list article').count();
}

async function addressValue(page) {
  return page.getByTestId('session-address').inputValue();
}

async function waitIdle(page) {
  await page.waitForFunction(() => !document.querySelector('.mk-busy'));
}

async function screenshot(page, name) {
  const file = path.join(evidenceDir, name);
  await page.screenshot({ path: file, fullPage: true });
  result.screenshots.push(path.relative(root, file));
}

function area(rect) {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
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

async function writeResult() {
  await writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify(result, null, 2));
}

process.on('SIGINT', () => { stopChildren(); process.exit(130); });
process.on('SIGTERM', () => { stopChildren(); process.exit(143); });

main().catch(async (error) => {
  result.errors.push(error instanceof Error ? error.stack || error.message : String(error));
  result.finishedAt = new Date().toISOString();
  try { await writeResult(); } catch {}
  stopChildren();
  console.error(error);
  process.exit(1);
});
