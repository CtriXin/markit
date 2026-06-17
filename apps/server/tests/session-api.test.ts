import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { createServerContext, type ServerContext } from '../src/context.js';

let fixtureServer: Server;
let apiServer: Server;
let context: ServerContext;
let dataDir: string;
let fixtureBaseUrl: string;
let apiBaseUrl: string;
const projectSnapshot = {
  schema: 'markit.project-snapshot.v1',
  source: 'client',
  capturedAt: '2026-06-17T00:00:00.000Z',
  project: {
    id: 'ptc-demo',
    name: 'Demo Project',
    status: 'active',
    gitlabPath: 'ptc/fe/demo',
    activeBranch: 'release-1.2.3',
    issueProjectPath: 'ptc/fe/demo',
    defaultAssignee: 'xin',
    labels: ['markit', 'bug']
  },
  domain: {
    host: 'demo.example.com',
    url: 'https://demo.example.com',
    env: 'prod',
    status: 'active',
    activeBranch: 'release-1.2.3'
  }
};

function listen(server: Server): Promise<string> {
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      resolveListen(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
}

describe('session and capture API', () => {
  beforeAll(async () => {
    const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/test-site');
    fixtureServer = createServer((req, res) => {
      const urlPath = req.url === '/' ? '/index.html' : req.url || '/index.html';
      const filePath = join(fixtureRoot, urlPath.replace(/^\//, ''));
      res.setHeader('content-type', extname(filePath) === '.html' ? 'text/html' : 'text/plain');
      createReadStream(filePath).on('error', () => {
        res.statusCode = 404;
        res.end('not found');
      }).pipe(res);
    });
    fixtureBaseUrl = await listen(fixtureServer);

    dataDir = await mkdtemp(join(tmpdir(), 'markit-api-'));
    context = await createServerContext({ dataDir });
    apiServer = createApp(context).listen(0, '127.0.0.1');
    apiBaseUrl = await new Promise<string>((resolveApi) => {
      apiServer.once('listening', () => {
        const address = apiServer.address();
        if (!address || typeof address === 'string') throw new Error('Missing api server address');
        resolveApi(`http://127.0.0.1:${address.port}`);
      });
    });
  }, 30_000);

  afterAll(async () => {
    await context.runtime.close();
    await close(apiServer);
    await close(fixtureServer);
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates a session with first viewport capture and readable image/DOM targets', async () => {
    const response = await fetch(`${apiBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${fixtureBaseUrl}/index.html`,
        viewport: { name: 'Mobile 390x844', width: 390, height: 844, deviceScaleFactor: 2, isMobile: true },
        projectSnapshot
      })
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.session.sourceUrl).toBe(`${fixtureBaseUrl}/index.html`);
    expect(body.session.projectSnapshot).toMatchObject({ project: { id: 'ptc-demo', name: 'Demo Project' }, domain: { host: 'demo.example.com' } });
    expect(body.capture.imageSize).toMatchObject({ width: 390, height: 844 });

    const imageResponse = await fetch(`${apiBaseUrl}/api/captures/${body.capture.id}/image`);
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get('content-type')).toContain('image/png');

    const domResponse = await fetch(`${apiBaseUrl}/api/captures/${body.capture.id}/dom-targets`);
    const targets = await domResponse.json();
    expect(targets.some((target: { selector: string }) => target.selector.includes('mobile-menu'))).toBe(true);

    const annotationResponse = await fetch(`${apiBaseUrl}/api/captures/${body.capture.id}/annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'pin', geometry: { captureRect: { x: 10, y: 10, width: 1, height: 1 } }, note: '截图证据验证' })
    });
    const annotationBody = await annotationResponse.json();
    const bugResponse = await fetch(`${apiBaseUrl}/api/bugs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: body.session.id,
        title: '粘贴截图证据',
        actual: '已有测试截图需要作为原始证据。',
        expected: 'Bug 详情和导出应保留截图。',
        severity: 'P2',
        status: 'draft',
        sourceUrl: body.session.sourceUrl,
        finalUrl: body.capture.finalUrl,
        primaryCaptureId: body.capture.id,
        annotationIds: [annotationBody.annotation.id],
        assets: [{
          kind: 'pasted-screenshot',
          fileName: 'compare.png',
          mimeType: 'image/png',
          label: '粘贴截图',
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
        }]
      })
    });
    expect(bugResponse.status).toBe(201);
    const bugBody = await bugResponse.json();
    expect(bugBody.bug.projectSnapshot).toMatchObject({ project: { id: 'ptc-demo', name: 'Demo Project' }, domain: { host: 'demo.example.com', activeBranch: 'release-1.2.3' } });
    expect(bugBody.assets).toHaveLength(1);
    expect(bugBody.bug.assetCount).toBe(1);
    const bugsWithProject = await fetch(`${apiBaseUrl}/api/bugs`).then((item) => item.json());
    expect(bugsWithProject.bugs.find((bug: { id: string }) => bug.id === bugBody.bug.id)?.projectSnapshot).toMatchObject({ project: { id: 'ptc-demo' } });
    const assetResponse = await fetch(`${apiBaseUrl}/api/bug-assets/${bugBody.assets[0].id}/image`);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toContain('image/png');
    const bulkExportResponse = await fetch(`${apiBaseUrl}/api/bugs/bulk-export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bugIds: [bugBody.bug.id] })
    });
    expect(bulkExportResponse.status).toBe(200);
    const bulkExport = await bulkExportResponse.json();
    expect(bulkExport).toMatchObject({ count: 1, exports: [expect.objectContaining({ bugId: bugBody.bug.id })] });
    const issueDraftResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bugIds: [bugBody.bug.id] })
    });
    expect(issueDraftResponse.status).toBe(200);
    const issueDraft = await issueDraftResponse.json();
    expect(issueDraft).toMatchObject({
      mode: 'dry-run',
      count: 1,
      issues: [expect.objectContaining({
        projectPath: 'ptc/fe/ptc-wiki',
        hubProjectPath: 'ptc/fe/ptc-wiki',
        sourceProjectPath: 'ptc/fe/demo',
        businessProjectPath: 'ptc/fe/demo',
        assignee: 'xin'
      })]
    });
    expect(await readFile(issueDraft.jsonPath, 'utf8')).toContain('markit.gitlab-issue-draft.v1');
    const issueMarkdown = await readFile(issueDraft.markdownPath, 'utf8');
    expect(issueMarkdown).toContain('[P2] demo.example.com - 粘贴截图证据');
    expect(issueMarkdown).toContain('- Issue Hub: ptc/fe/ptc-wiki');
    expect(issueMarkdown).toContain('- Business Repo: ptc/fe/demo');
    const previousGitLab = {
      markit: process.env.MARKIT_GITLAB_TOKEN,
      generic: process.env.GITLAB_TOKEN,
      glab: process.env.GLAB_TOKEN
    };
    delete process.env.MARKIT_GITLAB_TOKEN;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GLAB_TOKEN;
    try {
      const submitResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bugIds: [bugBody.bug.id] })
      });
      expect(submitResponse.status).toBe(424);
      expect(await submitResponse.json()).toMatchObject({ error: { code: 'gitlab_auth_missing' } });
    } finally {
      restoreEnv('MARKIT_GITLAB_TOKEN', previousGitLab.markit);
      restoreEnv('GITLAB_TOKEN', previousGitLab.generic);
      restoreEnv('GLAB_TOKEN', previousGitLab.glab);
    }

    const deleteResponse = await fetch(`${apiBaseUrl}/api/bugs/${bugBody.bug.id}`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(200);
    const bugsAfterDelete = await fetch(`${apiBaseUrl}/api/bugs`).then((item) => item.json());
    expect(bugsAfterDelete.bugs.some((bug: { id: string }) => bug.id === bugBody.bug.id)).toBe(false);
    const deletedAssetResponse = await fetch(`${apiBaseUrl}/api/bug-assets/${bugBody.assets[0].id}/image`);
    expect(deletedAssetResponse.status).toBe(404);
  }, 30_000);

  it('drafts unbound bugs to the wiki hub with unbound metadata', async () => {
    const createResponse = await fetch(`${apiBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${fixtureBaseUrl}/index.html`, viewport: { name: 'Desktop 800x500', width: 800, height: 500, deviceScaleFactor: 1 } })
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const bugResponse = await fetch(`${apiBaseUrl}/api/bugs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: created.session.id,
        title: '未绑定项目 Bug',
        actual: '直接输入 URL 时没有 catalog 项目绑定。',
        expected: '仍应能挂到统一 Wiki Hub，并标记 unbound。',
        severity: 'P3',
        status: 'draft',
        sourceUrl: created.session.sourceUrl,
        finalUrl: created.capture.finalUrl,
        primaryCaptureId: created.capture.id
      })
    });
    expect(bugResponse.status).toBe(201);
    const bugBody = await bugResponse.json();
    const issueDraftResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bugIds: [bugBody.bug.id] })
    });
    expect(issueDraftResponse.status).toBe(200);
    const issueDraft = await issueDraftResponse.json();
    expect(issueDraft.issues[0]).toMatchObject({
      projectPath: 'ptc/fe/ptc-wiki',
      bindingStatus: 'unbound',
      projectName: '',
      sourceProjectPath: '',
      businessProjectPath: ''
    });
    expect(issueDraft.issues[0].labels).toContain('unbound-project');
    expect(await readFile(issueDraft.markdownPath, 'utf8')).toContain('- Binding Status: unbound');
  }, 30_000);

  it('revives an inactive runtime page before browse actions', async () => {
    const createResponse = await fetch(`${apiBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${fixtureBaseUrl}/index.html`, viewport: { name: 'Desktop 800x500', width: 800, height: 500, deviceScaleFactor: 1 } })
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();

    await context.runtime.closeSession(created.session.id);
    context.repos.sessions.updateStatus(created.session.id, 'inactive');

    const actionResponse = await fetch(`${apiBaseUrl}/api/sessions/${created.session.id}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'scroll', delta: { x: 0, y: 420 }, baseSessionVersion: created.session.sessionVersion })
    });
    expect(actionResponse.status).toBe(200);
    const action = await actionResponse.json();
    expect(action.session.runtimeStatus).toBe('active');
    expect(action.capture.scroll.y).toBeGreaterThan(0);
  }, 30_000);

  it('rejects unsupported URL schemes at API boundary', async () => {
    const response = await fetch(`${apiBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'file:///tmp/test.html' })
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_url_scheme' } });
  });

  it('redacts AI provider secrets while exposing multimodal status', async () => {
    const previous = {
      provider: process.env.MARKIT_AI_PROVIDER,
      baseUrl: process.env.MARKIT_MMF_BASE_URL,
      apiKey: process.env.MARKIT_MMF_API_KEY,
      model: process.env.MARKIT_MMF_MODEL_ID,
      multimodal: process.env.MARKIT_MODEL_MULTIMODAL,
      config: process.env.MARKIT_MMF_CONFIG
    };
    process.env.MARKIT_AI_PROVIDER = 'local-mms-mmf';
    delete process.env.MARKIT_MMF_CONFIG;
    process.env.MARKIT_MMF_BASE_URL = 'http://127.0.0.1:9999/v1';
    process.env.MARKIT_MMF_API_KEY = 'secret-for-test';
    process.env.MARKIT_MMF_MODEL_ID = 'mmf-vision-test';
    process.env.MARKIT_MODEL_MULTIMODAL = 'true';
    try {
      const response = await fetch(`${apiBaseUrl}/api/ai/status`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ enabled: true, provider: 'local-mms-mmf', model: 'mmf-vision-test', supportsImages: true });
      expect(body.apiKey).toBeUndefined();
      expect(body.baseUrl).toBeUndefined();
    } finally {
      restoreEnv('MARKIT_AI_PROVIDER', previous.provider);
      restoreEnv('MARKIT_MMF_BASE_URL', previous.baseUrl);
      restoreEnv('MARKIT_MMF_API_KEY', previous.apiKey);
      restoreEnv('MARKIT_MMF_MODEL_ID', previous.model);
      restoreEnv('MARKIT_MODEL_MULTIMODAL', previous.multimodal);
      restoreEnv('MARKIT_MMF_CONFIG', previous.config);
    }
  });

  it('resolves local MMF from a server config file without exposing endpoint details', async () => {
    const previous = {
      provider: process.env.MARKIT_AI_PROVIDER,
      config: process.env.MARKIT_MMF_CONFIG,
      configKey: process.env.MARKIT_TEST_MMF_KEY,
      baseUrl: process.env.MARKIT_MMF_BASE_URL,
      apiKey: process.env.MARKIT_MMF_API_KEY,
      model: process.env.MARKIT_MMF_MODEL_ID
    };
    const configPath = join(dataDir, 'mmf.config.json');
    await writeFile(configPath, JSON.stringify({
      provider: 'local-mms-mmf',
      baseUrl: 'http://127.0.0.1:9998/v1',
      apiKeyEnv: 'MARKIT_TEST_MMF_KEY',
      modelId: 'mimo-v2.5',
      multimodal: true
    }));
    delete process.env.MARKIT_AI_PROVIDER;
    delete process.env.MARKIT_MMF_BASE_URL;
    delete process.env.MARKIT_MMF_API_KEY;
    delete process.env.MARKIT_MMF_MODEL_ID;
    process.env.MARKIT_MMF_CONFIG = configPath;
    process.env.MARKIT_TEST_MMF_KEY = 'config-secret';
    try {
      const response = await fetch(`${apiBaseUrl}/api/ai/status`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ enabled: true, provider: 'local-mms-mmf', model: 'mimo-v2.5', supportsImages: true, configSource: 'config-file' });
      expect(body.apiKey).toBeUndefined();
      expect(body.baseUrl).toBeUndefined();
    } finally {
      restoreEnv('MARKIT_AI_PROVIDER', previous.provider);
      restoreEnv('MARKIT_MMF_CONFIG', previous.config);
      restoreEnv('MARKIT_TEST_MMF_KEY', previous.configKey);
      restoreEnv('MARKIT_MMF_BASE_URL', previous.baseUrl);
      restoreEnv('MARKIT_MMF_API_KEY', previous.apiKey);
      restoreEnv('MARKIT_MMF_MODEL_ID', previous.model);
    }
  });

  it('auto-discovers a vision-capable local MMS route when MMF env is omitted', async () => {
    const previous = {
      provider: process.env.MARKIT_AI_PROVIDER,
      config: process.env.MARKIT_MMF_CONFIG,
      routePath: process.env.MARKIT_MMS_ROUTES_PATH,
      capabilitiesPath: process.env.MARKIT_MMS_CAPABILITIES_PATH,
      preferred: process.env.MARKIT_MMF_PREFERRED_MODELS,
      baseUrl: process.env.MARKIT_MMF_BASE_URL,
      apiKey: process.env.MARKIT_MMF_API_KEY,
      model: process.env.MARKIT_MMF_MODEL_ID
    };
    const routePath = join(dataDir, 'model-routes.json');
    const capabilitiesPath = join(dataDir, 'model-capabilities.json');
    await writeFile(routePath, JSON.stringify({
      version: 1,
      routes: {
        'mimo-v2.5': {
          primary: {
            provider_id: 'test-provider',
            openai_base_url: 'http://127.0.0.1:9997',
            api_key: 'route-secret',
            model_id: 'mimo-v2.5'
          },
          fallbacks: []
        }
      }
    }));
    await writeFile(capabilitiesPath, JSON.stringify({
      models: [{ alias: 'mimo-v2.5', canonical_model_id: 'mimo-v2.5', supports_vision: true }]
    }));
    delete process.env.MARKIT_AI_PROVIDER;
    delete process.env.MARKIT_MMF_CONFIG;
    delete process.env.MARKIT_MMF_BASE_URL;
    delete process.env.MARKIT_MMF_API_KEY;
    delete process.env.MARKIT_MMF_MODEL_ID;
    process.env.MARKIT_MMS_ROUTES_PATH = routePath;
    process.env.MARKIT_MMS_CAPABILITIES_PATH = capabilitiesPath;
    process.env.MARKIT_MMF_PREFERRED_MODELS = 'mimo-v2.5';
    try {
      const response = await fetch(`${apiBaseUrl}/api/ai/status`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ enabled: true, provider: 'local-mms-mmf', model: 'mimo-v2.5', supportsImages: true, configSource: 'mms-auto' });
      expect(body.apiKey).toBeUndefined();
      expect(body.baseUrl).toBeUndefined();
    } finally {
      restoreEnv('MARKIT_AI_PROVIDER', previous.provider);
      restoreEnv('MARKIT_MMF_CONFIG', previous.config);
      restoreEnv('MARKIT_MMS_ROUTES_PATH', previous.routePath);
      restoreEnv('MARKIT_MMS_CAPABILITIES_PATH', previous.capabilitiesPath);
      restoreEnv('MARKIT_MMF_PREFERRED_MODELS', previous.preferred);
      restoreEnv('MARKIT_MMF_BASE_URL', previous.baseUrl);
      restoreEnv('MARKIT_MMF_API_KEY', previous.apiKey);
      restoreEnv('MARKIT_MMF_MODEL_ID', previous.model);
    }
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
