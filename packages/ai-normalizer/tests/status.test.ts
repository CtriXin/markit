import { describe, expect, it } from 'vitest';
import { resolveNormalizerStatus } from '../src/index.js';

describe('normalizer bootstrap status', () => {
  it('defaults to disabled', () => {
    expect(resolveNormalizerStatus(undefined)).toMatchObject({ enabled: false, provider: 'off' });
  });

  it('enables mock provider', () => {
    expect(resolveNormalizerStatus('mock')).toEqual({ enabled: true, provider: 'mock' });
  });
});
