import type { Page } from 'playwright';

type Rect = { x: number; y: number; width: number; height: number };

type RawTarget = {
  tagName: string;
  role: string | undefined;
  ariaLabel: string | undefined;
  title: string | undefined;
  testId: string | undefined;
  idAttr: string | undefined;
  value: string | undefined;
  text: string;
  htmlHint: string;
  pageRect: Rect;
  viewportRect: Rect;
  visible: boolean;
};

export type DomTargetPayload = RawTarget & {
  id: string;
  selector: string;
  selectorKind: 'testid' | 'aria' | 'id' | 'css-path' | 'text-fallback';
  selectorScore: number;
  label: string;
  captureRect: Rect;
};

const preferredTags = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL', 'IMG', 'VIDEO', 'CANVAS', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LI', 'TD', 'TH', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'NAV', 'HEADER', 'FOOTER', 'FORM', 'DIALOG']);

export async function collectDomTargets(page: Page, mode: 'viewport' | 'fullPage'): Promise<DomTargetPayload[]> {
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  const raw = await page.evaluate((preferred) => {
    const preferredSet = new Set(preferred);
    const nodes = [...document.querySelectorAll<HTMLElement>('body *')];
    return nodes.flatMap((element): RawTarget[] => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const text = (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160);
      const role = element.getAttribute('role') || undefined;
      const ariaLabel = element.getAttribute('aria-label') || undefined;
      const title = element.getAttribute('title') || undefined;
      const testId = element.getAttribute('data-testid') || undefined;
      const idAttr = element.getAttribute('id') || undefined;
      const value = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement ? element.value : undefined;
      const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.pointerEvents !== 'none';
      const meaningful = preferredSet.has(element.tagName) || Boolean(role || ariaLabel || title || testId || idAttr) || (text.length > 0 && text.length <= 120 && element.children.length <= 2);
      if (!visible || !meaningful) return [];
      return [{
        tagName: element.tagName.toLowerCase(),
        role,
        ariaLabel,
        title,
        testId,
        idAttr,
        value,
        text,
        htmlHint: element.outerHTML.replace(/\s+/g, ' ').slice(0, 220),
        pageRect: { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height },
        viewportRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        visible
      }];
    }).slice(0, 300);
  }, [...preferredTags]);

  return raw.map((target, index) => {
    const selectorInfo = selectorFor(target);
    const origin = mode === 'fullPage' ? { x: 0, y: 0 } : scroll;
    return {
      ...target,
      id: `dom_${index + 1}`,
      selector: selectorInfo.selector,
      selectorKind: selectorInfo.kind,
      selectorScore: scoreSelector(selectorInfo.kind, target),
      label: target.ariaLabel || target.title || target.text || target.tagName,
      captureRect: {
        x: target.pageRect.x - origin.x,
        y: target.pageRect.y - origin.y,
        width: target.pageRect.width,
        height: target.pageRect.height
      }
    };
  });
}

function selectorFor(target: RawTarget): { selector: string; kind: DomTargetPayload['selectorKind'] } {
  if (target.testId) return { selector: `[data-testid="${cssEscape(target.testId)}"]`, kind: 'testid' };
  if (target.ariaLabel) return { selector: `[aria-label="${cssEscape(target.ariaLabel)}"]`, kind: 'aria' };
  if (target.idAttr) return { selector: `#${cssEscape(target.idAttr)}`, kind: 'id' };
  if (target.text && target.text.length <= 80) return { selector: `${target.tagName}:has-text("${target.text.replace(/"/g, '\\"')}")`, kind: 'text-fallback' };
  return { selector: target.tagName, kind: 'css-path' };
}

function scoreSelector(kind: DomTargetPayload['selectorKind'], target: RawTarget): number {
  const base = { testid: 100, aria: 90, id: 80, 'css-path': 55, 'text-fallback': 35 }[kind];
  const interactive = ['a', 'button', 'input', 'textarea', 'select', 'label'].includes(target.tagName) ? 10 : 0;
  const accessible = target.role || target.ariaLabel || target.title ? 8 : 0;
  const longTextPenalty = kind === 'text-fallback' && target.text.length > 80 ? -10 : 0;
  return Math.max(0, Math.min(100, base + interactive + accessible + longTextPenalty));
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
