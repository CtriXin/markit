import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';

let server: Server;
let baseUrl: string;

describe('health endpoint', () => {
  beforeAll(async () => {
    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test server address');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it('returns local health without wildcard CORS', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
    const json = await response.json();
    expect(json).toMatchObject({ ok: true, name: 'markit-server', version: '0.1.0' });
    expect(new Date(json.time).toString()).not.toBe('Invalid Date');
  });
});
