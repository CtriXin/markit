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
    expect(source).toContain('区域标注');
    expect(source).toContain('圈选');
    expect(source).toContain('快速保存');
    expect(source).toContain('撤销标注');
    expect(source).toContain('截图 / 对比证据');
    expect(source).toContain('Cmd+V 粘贴截图');
    expect(source).toContain('快速评论');
    expect(source).toContain('原始需求链接');
    expect(source).toContain('Bug 草稿');
    expect(source).toContain('保存为一个 Bug');
    expect(source).toContain('data-testid="url-input"');
    expect(source).toContain('Project Catalog');
    expect(source).toContain('testId="catalog-project-select"');
    expect(source).toContain('直接输入 URL 仍可测试');
    expect(source).toContain('SearchableSelect');
    expect(source).toContain('mk-project-context');
    expect(source).toContain('保存归属');
    expect(source).toContain('className="mk-panel-section mk-meta-list" open');
    expect(source).toContain('projectSnapshot');
    expect(source).toContain('绑定域名');
    expect(source).not.toMatch(/ChatComposer|project\/run/i);
  });
});
