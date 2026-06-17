#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const evidenceDir = path.join(root, '.agent.local', 'evidence', 'catalog-snapshot-smoke');
const dataDir = path.join(evidenceDir, '.markit');
const catalogDir = path.join(evidenceDir, 'ptc-wiki-fixture');
const appUrl = 'http://127.0.0.1:5173';
const apiUrl = 'http://127.0.0.1:4317';
const children = [];
const logs = [];
let fixtureServer;

async function main() {
  await rm(evidenceDir, { recursive: true, force: true });
  await mkdir(evidenceDir, { recursive: true });
  await writeCatalogFixture(catalogDir);
  const fixtureBaseUrl = await startFixtureServer();
  const targetUrl = `${fixtureBaseUrl}/index.html`;

  startProcess('pnpm', ['dev'], {
    cwd: root,
    name: 'app',
    env: { ...process.env, MARKIT_AI_PROVIDER: 'mock', MARKIT_DATA_DIR: dataDir, MARKIT_CATALOG_ROOT: catalogDir }
  });
  await waitForHttp(`${apiUrl}/api/health`, 'markit api');
  await waitForHttp(appUrl, 'markit web');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(30_000);
  try {
    await page.goto(appUrl, { waitUntil: 'networkidle' });
    await page.getByTestId('url-input').fill(targetUrl);
    await page.waitForSelector('[data-testid="catalog-url-match"]');
    const matchText = await page.getByTestId('catalog-url-match').innerText();
    if (!matchText.includes('Demo Catalog Project')) throw new Error(`Catalog match missing project: ${matchText}`);

    await page.getByTestId('viewport-select').selectOption('mobile-390');
    await page.getByTestId('open-session').click();
    await page.waitForSelector('[data-testid="device-mobile"] img');
    await page.waitForFunction(() => !document.querySelector('.mk-busy'));
    const projectTabText = await page.locator('.mk-project-tab').innerText();
    if (!projectTabText.includes('Demo Catalog Project') || !projectTabText.includes('127.0.0.1')) {
      throw new Error(`Project tab missing snapshot: ${projectTabText}`);
    }
    await page.screenshot({ path: path.join(evidenceDir, '01-catalog-session.png'), fullPage: true });

    const sessions = await fetch(`${apiUrl}/api/sessions`).then((response) => response.json());
    const session = sessions.sessions.at(-1);
    if (session?.projectSnapshot?.project?.id !== 'demo-catalog-project') {
      throw new Error(`Session snapshot missing: ${JSON.stringify(session?.projectSnapshot)}`);
    }

    const bugResponse = await fetch(`${apiUrl}/api/bugs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        title: 'Catalog snapshot smoke',
        actual: 'Catalog project binding should be preserved on the session.',
        expected: 'Bug export should include project metadata.',
        severity: 'P2',
        status: 'draft',
        sourceUrl: session.sourceUrl,
        finalUrl: session.currentUrl,
        tags: ['catalog-smoke']
      })
    });
    if (bugResponse.status !== 201) throw new Error(`Bug create failed: ${bugResponse.status} ${await bugResponse.text()}`);
    const detail = await bugResponse.json();
    const exported = await fetch(`${apiUrl}/api/bugs/${detail.bug.id}/export`, { method: 'POST' }).then((response) => response.json());
    if (!exported.markdown.includes('Project: Demo Catalog Project') || !exported.markdown.includes('Branch: release-demo')) {
      throw new Error(`Export markdown missing project metadata: ${exported.markdown}`);
    }

    await writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify({
      ok: true,
      targetUrl,
      projectTabText,
      sessionProjectSnapshot: session.projectSnapshot,
      exportPath: exported.exportPath,
      screenshots: ['01-catalog-session.png']
    }, null, 2));
  } finally {
    await browser.close();
    stopChildren();
    await Promise.allSettled(children.map((child) => onceExit(child.proc)));
    await closeFixtureServer();
    await writeFile(path.join(evidenceDir, 'process.log'), logs.join(''));
  }
}

async function writeCatalogFixture(dir) {
  await mkdir(path.join(dir, 'integrations'), { recursive: true });
  await mkdir(path.join(dir, 'catalog', 'projects'), { recursive: true });
  await writeFile(path.join(dir, 'integrations', 'markit.json'), JSON.stringify({
    schema: 'markit.catalog.binding.v1',
    consumer: { id: 'markit', name: 'Markit', repo: 'git@example.com:markit.git' },
    catalog: { manifest: 'catalog/catalog.manifest.json', domainIndex: 'catalog/domains.json', projectsGlob: 'catalog/projects/*.json' },
    workflow: { syncPolicy: 'fixture' }
  }, null, 2));
  await writeFile(path.join(dir, 'catalog', 'catalog.manifest.json'), JSON.stringify({
    schema: 'ptc.catalog.v1',
    generatedAt: '2026-06-17T00:00:00.000Z',
    projectCount: 1,
    domainCount: 1,
    projects: ['projects/demo-catalog-project.json'],
    domainIndex: 'domains.json',
    source: { kind: 'fixture', generatedAt: '2026-06-17T00:00:00.000Z', pendingAssociations: 0 }
  }, null, 2));
  await writeFile(path.join(dir, 'catalog', 'domains.json'), JSON.stringify({
    schema: 'ptc.domain-index.v1',
    generatedAt: '2026-06-17T00:00:00.000Z',
    domains: {
      '127.0.0.1': {
        projectId: 'demo-catalog-project',
        projectName: 'Demo Catalog Project',
        scmpService: 'ptc-demo-catalog',
        gitlabPath: 'ptc/fe/demo-catalog',
        activeBranch: 'release-demo',
        defaultAssignee: 'xin',
        env: 'test',
        status: 'active'
      }
    }
  }, null, 2));
  await writeFile(path.join(dir, 'catalog', 'projects', 'demo-catalog-project.json'), JSON.stringify({
    schema: 'ptc.project.v1',
    id: 'demo-catalog-project',
    name: 'Demo Catalog Project',
    aliases: ['catalog smoke'],
    status: 'active',
    scmp: { service: 'ptc-demo-catalog' },
    repo: { gitlabPath: 'ptc/fe/demo-catalog', activeBranch: 'release-demo' },
    domains: [{ host: '127.0.0.1', env: 'test', status: 'active' }],
    gitlab: { issueProjectPath: 'ptc/fe/demo-catalog', defaultAssignee: 'xin', labels: ['markit', 'bug'] },
    testing: { enabled: true, defaultViewport: 'mobile-390', viewports: ['mobile-390'] },
    owners: { qa: ['xin'], dev: ['dev1'] },
    sources: [{ kind: 'fixture', path: 'fixture' }],
    confidence: 1
  }, null, 2));
}

function startFixtureServer() {
  const fixtureRoot = path.join(root, 'fixtures', 'test-site');
  fixtureServer = createServer((req, res) => {
    const urlPath = req.url === '/' ? '/index.html' : req.url || '/index.html';
    const filePath = path.join(fixtureRoot, urlPath.replace(/^\//, ''));
    res.setHeader('content-type', path.extname(filePath) === '.html' ? 'text/html' : 'text/plain');
    createReadStream(filePath).on('error', () => {
      res.statusCode = 404;
      res.end('not found');
    }).pipe(res);
  });
  return new Promise((resolve) => {
    fixtureServer.listen(0, '127.0.0.1', () => {
      const address = fixtureServer.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture server address');
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeFixtureServer() {
  return new Promise((resolve, reject) => {
    if (!fixtureServer) return resolve();
    fixtureServer.close((error) => (error ? reject(error) : resolve()));
  });
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

process.on('SIGINT', () => { stopChildren(); void closeFixtureServer().finally(() => process.exit(130)); });
process.on('SIGTERM', () => { stopChildren(); void closeFixtureServer().finally(() => process.exit(143)); });

main().catch(async (error) => {
  try { await writeFile(path.join(evidenceDir, 'result.json'), JSON.stringify({ ok: false, error: error instanceof Error ? error.stack || error.message : String(error) }, null, 2)); } catch {}
  stopChildren();
  await closeFixtureServer().catch(() => undefined);
  console.error(error);
  process.exit(1);
});
