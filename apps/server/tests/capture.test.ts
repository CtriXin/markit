import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { capturePage } from '../src/runtime/capture.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('capturePage', () => {
  it('waits for page fonts before taking the screenshot', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'markit-capture-'));
    tempDirs.push(dataDir);
    const calls: string[] = [];
    let evaluateCount = 0;
    const png = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    const page = {
      evaluate: vi.fn(async () => {
        calls.push('evaluate');
        evaluateCount += 1;
        if (evaluateCount === 1) return undefined;
        if (evaluateCount === 4) return [];
        return { x: 0, y: 0 };
      }),
      screenshot: vi.fn(async () => {
        calls.push('screenshot');
        return png;
      }),
      waitForTimeout: vi.fn(async () => {
        calls.push('waitForTimeout');
      })
    } as unknown as Page;

    await capturePage({
      page,
      dataDir,
      captureId: 'cap_fonts',
      mode: 'viewport',
      metadata: { id: 'cap_fonts' }
    });

    expect(calls.slice(0, 3)).toEqual(['evaluate', 'waitForTimeout', 'screenshot']);
    expect(page.screenshot).toHaveBeenCalledWith(expect.objectContaining({ scale: 'css' }));
  });
});
