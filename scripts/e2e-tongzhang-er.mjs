#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const fixtureDir = path.join(root, 'fixtures', 'test-site');
const bugFixturePath = path.join(root, 'fixtures', 'feishu-bugs', 'tongzhang-er.json');
const evidenceDir = path.join(root, '.agent.local', 'evidence', 'tongzhang-er-final');
const appUrl = 'http://127.0.0.1:5173';
const apiUrl = 'http://127.0.0.1:4317';
const fixtureUrl = 'http://127.0.0.1:4888/inflation-2.html';

const children = [];
const logs = [];
const result = {
  startedAt: new Date().toISOString(),
  targetUrl: fixtureUrl,
  screenshots: [],
  bugs: [],
  exports: [],
  capabilities: {},
  errors: []
};

async function main() {
  await rm(path.join(root, '.markit'), { recursive: true, force: true });
  await rm(path.join(root, 'apps', 'server', '.markit'), { recursive: true, force: true });
  await rm(evidenceDir, { recursive: true, force: true });
  await mkdir(evidenceDir, { recursive: true });

  const fixture = startProcess('python3', ['-m', 'http.server', '4888', '--bind', '127.0.0.1'], { cwd: fixtureDir, name: 'fixture' });
  const app = startProcess('pnpm', ['dev'], { cwd: root, name: 'app', env: { ...process.env, MARKIT_AI_PROVIDER: 'mock' } });

  await waitForHttp(fixtureUrl, 'fixture server');
  await waitForHttp(`${apiUrl}/api/health`, 'markit api');
  await waitForHttp(appUrl, 'markit web');

  const bugFixture = JSON.parse(await readFile(bugFixturePath, 'utf8'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(20_000);
  try {
    await page.goto(appUrl, { waitUntil: 'networkidle' });
    await page.getByTestId('url-input').fill(fixtureUrl);
    await page.getByTestId('viewport-select').selectOption('mobile-390');
    await page.getByTestId('open-session').click();
    await page.waitForSelector('[data-testid="canvas-layer"] img');
    await page.waitForSelector('[data-testid="device-mobile"] img');
    await waitIdle(page);
    await screenshot(page, '01-session-open-single.png');
    await verifyDualPreviewControls(page);

    const bug1 = bugFixture.bugs.find((bug) => bug.id === 'TZ2-001');
    await createBugFromTarget(page, bug1, 'element', 'mobile-menu');
    await screenshot(page, '02-bug-menu-element.png');

    const bug2 = bugFixture.bugs.find((bug) => bug.id === 'TZ2-002');
    await createBugFromTarget(page, bug2, 'pin', 'primary-cta');
    await screenshot(page, '03-bug-cta-pin.png');

    const bug3 = bugFixture.bugs.find((bug) => bug.id === 'TZ2-003');
    await createBugFromTarget(page, bug3, 'freehand', 'chart-label');
    await screenshot(page, '04-bug-chart-draw.png');

    const beforeDropdownScroll = await currentCaptureId(page);
    await page.getByTestId('scroll-down').click();
    await waitForCaptureChange(page, beforeDropdownScroll);
    await waitIdle(page);
    await setTool(page, 'browse');
    const beforeDropdownCapture = await currentCaptureId(page);
    await clickTarget(page, 'country-dropdown');
    await waitForCaptureChange(page, beforeDropdownCapture);
    await waitIdle(page);
    const bug5 = bugFixture.bugs.find((bug) => bug.id === 'TZ2-005');
    await createBugFromTarget(page, bug5, 'element', 'country-dropdown');
    await screenshot(page, '05-bug-dropdown-open.png');

    const bug4 = bugFixture.bugs.find((bug) => bug.id === 'TZ2-004');
    await createBugFromTarget(page, bug4, 'rect', 'country-card');
    await screenshot(page, '06-bug-country-rect.png');

    await verifySectionPick(page);
    await screenshot(page, '06b-section-pick.png');

    await verifyTypeAction(page);
    await screenshot(page, '07-type-action.png');

    const beforeFullPage = await currentCaptureId(page);
    await page.getByTestId('capture-fullpage').click();
    await waitForCaptureChange(page, beforeFullPage);
    await waitIdle(page);
    result.capabilities.fullPageCapture = true;
    await screenshot(page, '08-fullpage-capture.png');

    await page.getByTestId('nav-bugs').click();
    await page.waitForFunction(() => window.scrollY === 0);
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="bug-card"]').length === 5);
    await screenshot(page, '09-bug-list-before-export.png');

    const cards = await page.locator('[data-testid="bug-card"]').all();
    const cardTexts = [];
    for (const card of cards) cardTexts.push(await card.innerText());
    const zeroAnnotationCards = cardTexts.filter((text) => /0 条标注/.test(text));
    if (zeroAnnotationCards.length) throw new Error(`Found bug cards with zero annotations: ${zeroAnnotationCards.join(' | ')}`);

    const exportLocator = page.locator('[data-testid="bug-card"] [data-testid="export-evidence"]');
    const exportButtonCount = await exportLocator.count();
    for (let i = 0; i < exportButtonCount; i += 1) {
      await exportLocator.nth(i).click();
      await waitForExportCount(i + 1);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => window.scrollY === 0);
    await screenshot(page, '10-bugs-exported.png');

    const apiBugs = await jsonFetch(`${apiUrl}/api/bugs`);
    result.bugs = apiBugs.bugs.map((bug) => ({ id: bug.id, title: bug.title, severity: bug.severity, annotationCount: bug.annotationCount, exportPath: bug.exportPath }));
    result.exports = await inspectExports();
    if (result.bugs.length !== 5) throw new Error(`Expected 5 bugs, got ${result.bugs.length}`);
    if (result.bugs.some((bug) => bug.annotationCount < 1)) throw new Error(`Every bug must have annotation evidence: ${JSON.stringify(result.bugs)}`);
    if (result.exports.length !== 5) throw new Error(`Expected 5 export directories, got ${result.exports.length}`);
    if (result.exports.some((item) => !item.hasMarkdown || !item.hasJson || item.annotatedScreenshots < 1 || item.crops < 1)) {
      throw new Error(`Incomplete exports: ${JSON.stringify(result.exports, null, 2)}`);
    }

    result.capabilities.domainAccess = true;
    result.capabilities.browseClick = true;
    result.capabilities.scroll = true;
    result.capabilities.type = true;
    result.capabilities.pin = true;
    result.capabilities.rect = true;
    result.capabilities.freehand = true;
    result.capabilities.elementPick = true;
    result.capabilities.sectionPick = true;
    result.capabilities.aiNormalize = true;
    result.capabilities.bugListDetail = true;
    result.capabilities.exportEvidence = true;
    result.finishedAt = new Date().toISOString();
    await writeResult();
  } finally {
    await browser.close();
    stopChildren();
    await Promise.allSettled(children.map((child) => onceExit(child.proc)));
  }
}

async function createBugFromTarget(page, bug, tool, testId) {
  if (!bug) throw new Error(`Missing bug fixture for ${testId}`);
  const beforeCount = await annotationCount(page);
  const comment = `${bug.id} ${bug.actual} 应该${bug.expected}`;
  await page.getByTestId('bug-comment').fill(comment);
  await setTool(page, tool);
  if (tool === 'freehand') await drawOnTarget(page, testId);
  else if (tool === 'rect') await rectOnTarget(page, testId);
  else await clickTarget(page, testId);
  await page.waitForFunction((count) => document.querySelectorAll('.mk-ann-list article').length > count, beforeCount);
  await page.waitForFunction(() => document.querySelector('[data-testid="normalize-bug"]') && !document.querySelector('[data-testid="normalize-bug"]').disabled);
  await page.getByTestId('normalize-bug').click();
  await page.waitForFunction(() => document.body.innerText.includes('AI 已整理到可编辑字段。'));
  await page.getByTestId('bug-title').fill(bug.title);
  await page.getByTestId('bug-severity').selectOption(bug.severity);
  await page.getByTestId('bug-status').selectOption('open');
  await page.getByTestId('bug-actual').fill(bug.actual);
  await page.getByTestId('bug-expected').fill(bug.expected);
  await page.getByTestId('save-bug').click();
  await page.waitForFunction(() => document.body.innerText.includes('已保存 Bug bug_'));
  await page.waitForTimeout(120);
}

async function verifyTypeAction(page) {
  const beforeScroll = await currentCaptureId(page);
  await page.getByTestId('scroll-down').click();
  await waitForCaptureChange(page, beforeScroll);
  await waitIdle(page);
  await setTool(page, 'browse');
  await clickTarget(page, 'feedback-input');
  await page.waitForTimeout(400);
  await waitIdle(page);
  const beforeType = await currentCaptureId(page);
  await page.getByTestId('action-text').fill('Markit 已输入备注');
  await page.getByTestId('type-action').click();
  await waitForCaptureChange(page, beforeType);
  await waitIdle(page);
  const typedTarget = await domTarget(page, 'feedback-input');
  if (typedTarget.value !== 'Markit 已输入备注') {
    throw new Error(`Expected feedback input value to be typed, got ${JSON.stringify(typedTarget.value)}`);
  }
  result.capabilities.typeText = 'Markit 已输入备注';
  result.capabilities.typeValueVerified = true;
}

async function verifyDualPreviewControls(page) {
  const initialPcCount = await page.getByTestId('device-pc').count();
  const initialMobileBox = await page.getByTestId('device-mobile').boundingBox();
  if (initialPcCount !== 0 || !initialMobileBox || initialMobileBox.width < 180) {
    throw new Error(`Expected single mobile preview by default: pcCount=${initialPcCount} mobile=${JSON.stringify(initialMobileBox)}`);
  }
  result.capabilities.singleDeviceDefault = true;

  await page.getByTestId('preview-dual').click();
  await page.waitForSelector('[data-testid="device-pc"] img');
  await page.waitForSelector('[data-testid="device-mobile"] img');
  await waitIdle(page);
  await screenshot(page, '01b-dual-toggle.png');

  const pcBox = await page.getByTestId('device-pc').boundingBox();
  const mobileBox = await page.getByTestId('device-mobile').boundingBox();
  if (!pcBox || !mobileBox || pcBox.width < 240 || mobileBox.width < 180) {
    throw new Error(`Dual preview frames are not visible enough: pc=${JSON.stringify(pcBox)} mobile=${JSON.stringify(mobileBox)}`);
  }

  await page.getByTestId('zoom-in').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="zoom-label"]')?.textContent?.includes('110%'));
  await page.getByTestId('zoom-out').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="zoom-label"]')?.textContent?.includes('100%'));
  result.capabilities.zoomControls = true;
  await screenshot(page, '01c-dual-zoom.png');
  await page.getByTestId('zoom-fit').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="zoom-label"]')?.textContent?.includes('Fit'));

  await page.getByTestId('toggle-left-rail').click();
  await page.getByTestId('toggle-right-panel').click();
  await page.waitForFunction(() => {
    const workbench = document.querySelector('[data-testid="workbench"]');
    return workbench?.classList.contains('is-left-collapsed') && workbench?.classList.contains('is-right-collapsed');
  });
  result.capabilities.collapsibleRails = true;
  await screenshot(page, '01d-collapsed-rails.png');
  await page.getByTestId('toggle-left-rail').click();
  await page.getByTestId('toggle-right-panel').click();
  await page.waitForFunction(() => {
    const workbench = document.querySelector('[data-testid="workbench"]');
    return workbench && !workbench.classList.contains('is-left-collapsed') && !workbench.classList.contains('is-right-collapsed');
  });

  const beforeNavigate = await currentCaptureId(page);
  await page.getByTestId('session-address').fill(fixtureUrl);
  await page.getByTestId('navigate-all').click();
  await waitForCaptureChange(page, beforeNavigate);
  await waitIdle(page);
  result.capabilities.addressBarNavigation = true;
  result.capabilities.dualDevicePreview = true;
  await screenshot(page, '01e-address-navigation.png');
}

async function verifySectionPick(page) {
  const beforeCount = await annotationCount(page);
  await page.getByTestId('bug-comment').fill('TZ2-SECTION 区块选择应能选中整张国家卡片，而不是只落在文字节点上');
  await setTool(page, 'section');
  await clickTarget(page, 'country-card');
  await page.waitForFunction((count) => document.querySelectorAll('.mk-ann-list article').length > count, beforeCount);
  const lastAnnotation = await page.locator('.mk-ann-list article').last().innerText();
  if (!/区块/.test(lastAnnotation) || !/country-card|article/i.test(lastAnnotation)) {
    throw new Error(`Section annotation did not capture a section-like target: ${lastAnnotation}`);
  }
}

async function setTool(page, tool) {
  await page.getByTestId(`tool-${tool}`).click();
  await page.waitForSelector(`[data-testid="tool-${tool}"].is-active`);
}

async function clickTarget(page, testId, fx = 0.5, fy = 0.5) {
  const target = await domTarget(page, testId);
  const point = await screenPoint(page, target.captureRect, fx, fy);
  await page.mouse.click(point.x, point.y);
}

async function rectOnTarget(page, testId) {
  const target = await domTarget(page, testId);
  const rect = testId === 'country-card'
    ? { ...target.captureRect, y: Math.max(2, target.captureRect.y - 54), height: Math.min(82, target.captureRect.height) }
    : target.captureRect;
  const start = await screenPoint(page, rect, 0.08, 0.16);
  const end = await screenPoint(page, rect, 0.94, 0.82);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  await page.mouse.up();
}

async function drawOnTarget(page, testId) {
  const target = await domTarget(page, testId);
  const a = await screenPoint(page, target.captureRect, 0.08, 0.5);
  const b = await screenPoint(page, target.captureRect, 0.48, 0.2);
  const c = await screenPoint(page, target.captureRect, 0.92, 0.62);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.move(c.x, c.y, { steps: 5 });
  await page.mouse.up();
}

async function domTarget(page, testId) {
  const captureId = await currentCaptureId(page);
  const targets = await jsonFetch(`${apiUrl}/api/captures/${captureId}/dom-targets`);
  const matches = targets.filter((target) => target.selector.includes(`"${testId}"`) || target.htmlHint.includes(`data-testid="${testId}"`));
  if (!matches.length) throw new Error(`DOM target not found for data-testid=${testId} in capture ${captureId}`);
  matches.sort((a, b) => scoreTarget(b, testId) - scoreTarget(a, testId) || (a.captureRect.width * a.captureRect.height) - (b.captureRect.width * b.captureRect.height));
  return matches[0];
}

function scoreTarget(target, testId) {
  let score = 0;
  if (target.selector.includes(`"${testId}"`)) score += 1000;
  if (target.selectorKind === 'testid') score += 100;
  if (['button', 'a', 'input'].includes(target.tagName)) score += 20;
  return score;
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

async function currentCaptureId(page) {
  const src = await page.locator('[data-testid="canvas-layer"] img').getAttribute('src');
  const match = src?.match(/\/api\/captures\/([^/]+)\/image/);
  if (!match) throw new Error(`Cannot parse capture id from ${src}`);
  return match[1];
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

async function waitIdle(page) {
  await page.waitForFunction(() => !document.querySelector('.mk-busy'));
}

async function screenshot(page, name) {
  const file = path.join(evidenceDir, name);
  await page.screenshot({ path: file, fullPage: true });
  result.screenshots.push(path.relative(root, file));
}


async function waitForExportCount(expected) {
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    const body = await jsonFetch(`${apiUrl}/api/bugs`);
    const count = body.bugs.filter((bug) => bug.exportPath).length;
    if (count >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${expected} exported bugs`);
}

async function inspectExports() {
  const exportRoot = path.join(root, '.markit', 'exports');
  const dirs = existsSync(exportRoot) ? await readdir(exportRoot) : [];
  const items = [];
  for (const dir of dirs) {
    const full = path.join(exportRoot, dir);
    if (!(await stat(full)).isDirectory()) continue;
    const captureRoot = path.join(full, 'captures');
    const captureDirs = existsSync(captureRoot) ? await readdir(captureRoot) : [];
    let annotatedScreenshots = 0;
    let crops = 0;
    for (const captureDir of captureDirs) {
      if (existsSync(path.join(captureRoot, captureDir, 'screenshot.annotated.png'))) annotatedScreenshots += 1;
      const cropDir = path.join(captureRoot, captureDir, 'crops');
      if (existsSync(cropDir)) crops += (await readdir(cropDir)).filter((name) => name.endsWith('.png')).length;
    }
    items.push({ bugId: dir, hasMarkdown: existsSync(path.join(full, 'bug.md')), hasJson: existsSync(path.join(full, 'bug.json')), annotatedScreenshots, crops });
  }
  return items;
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

async function jsonFetch(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} -> ${response.status}`);
  return response.json();
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
  const text = String(chunk);
  logs.push(`[${name}] ${text}`);
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
  await writeFile(path.join(evidenceDir, 'e2e-result.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(evidenceDir, 'process.log'), logs.join(''));
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
