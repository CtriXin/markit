import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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
      body: JSON.stringify({ url: `${fixtureBaseUrl}/index.html`, viewport: { name: 'Mobile 390x844', width: 390, height: 844, deviceScaleFactor: 2, isMobile: true } })
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.session.sourceUrl).toBe(`${fixtureBaseUrl}/index.html`);
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
    expect(bugBody.assets).toHaveLength(1);
    expect(bugBody.bug.assetCount).toBe(1);
    const assetResponse = await fetch(`${apiBaseUrl}/api/bug-assets/${bugBody.assets[0].id}/image`);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toContain('image/png');
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
      multimodal: process.env.MARKIT_MODEL_MULTIMODAL
    };
    process.env.MARKIT_AI_PROVIDER = 'local-mms-mmf';
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
    } finally {
      restoreEnv('MARKIT_AI_PROVIDER', previous.provider);
      restoreEnv('MARKIT_MMF_BASE_URL', previous.baseUrl);
      restoreEnv('MARKIT_MMF_API_KEY', previous.apiKey);
      restoreEnv('MARKIT_MMF_MODEL_ID', previous.model);
      restoreEnv('MARKIT_MODEL_MULTIMODAL', previous.multimodal);
    }
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
