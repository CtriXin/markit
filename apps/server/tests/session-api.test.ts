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
});
