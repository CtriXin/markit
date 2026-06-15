import { describe, expect, it } from 'vitest';
import { defaultIssueSinks } from '../src/index.js';

describe('issue sinks bootstrap', () => {
  it('keeps local evidence enabled and Feishu deferred', () => {
    expect(defaultIssueSinks.find((sink) => sink.kind === 'local-evidence')?.enabled).toBe(true);
    expect(defaultIssueSinks.find((sink) => sink.kind === 'feishu-later')?.enabled).toBe(false);
  });
});
