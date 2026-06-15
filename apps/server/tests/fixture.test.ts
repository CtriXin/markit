import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/test-site');

describe('fixture test site', () => {
  it('contains elements required by capture and browse probes', () => {
    const index = readFileSync(resolve(fixtureRoot, 'index.html'), 'utf8');
    expect(index).toContain('data-testid="mobile-menu"');
    expect(index).toContain('data-testid="countries-toggle"');
    expect(index).toContain('data-testid="feedback-input"');
    expect(index).toContain('id="probe-box"');
  });
});
