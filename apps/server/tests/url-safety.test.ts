import { describe, expect, it } from 'vitest';
import { MarkitHttpError, parseHttpUrl } from '../src/url-safety.js';

describe('URL safety', () => {
  it('accepts http and https URLs', () => {
    expect(parseHttpUrl('http://127.0.0.1:3000').protocol).toBe('http:');
    expect(parseHttpUrl('https://example.com').protocol).toBe('https:');
  });

  it('rejects unsafe schemes', () => {
    expect(() => parseHttpUrl('file:///tmp/test.html')).toThrow(MarkitHttpError);
    try {
      parseHttpUrl('javascript:alert(1)');
    } catch (error) {
      expect(error).toMatchObject({ status: 400, code: 'invalid_url_scheme' });
    }
  });
});
