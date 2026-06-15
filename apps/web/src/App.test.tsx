import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('bootstrap shell source', () => {
  it('keeps Markit Chinese intake copy and avoids unrelated product surfaces', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'App.tsx'), 'utf8');
    expect(source).toContain('Markit');
    expect(source).toContain('把任意真实 URL 变成可点击、可标注、可导出证据的 Bug 工作台');
    expect(source).toContain('默认单端验收');
    expect(source).toContain('区块');
    expect(source).toContain('圈选');
    expect(source).toContain('快速保存');
    expect(source).toContain('原始需求链接');
    expect(source).toContain('评论此元素');
    expect(source).toContain('data-testid="url-input"');
    expect(source).not.toMatch(/ChatComposer|project\/run/i);
  });
});
