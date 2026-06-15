export type Rect = { x: number; y: number; width: number; height: number };
export type Point = { x: number; y: number };
export type CaptureMode = 'viewport' | 'fullPage';

export type CaptureGeometryContext = {
  mode: CaptureMode;
  scroll: Point;
};

export type DomTargetForPick = {
  id: string;
  captureRect: Rect;
  selectorScore: number;
};

export function normalizeRect(start: Point, end: Point): Rect {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return { x, y, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

export function capturePointToPage(point: Point, context: CaptureGeometryContext): Point {
  if (context.mode === 'fullPage') return { ...point };
  return { x: point.x + context.scroll.x, y: point.y + context.scroll.y };
}

export function pagePointToCapture(point: Point, context: CaptureGeometryContext): Point {
  if (context.mode === 'fullPage') return { ...point };
  return { x: point.x - context.scroll.x, y: point.y - context.scroll.y };
}

export function captureRectToPage(rect: Rect, context: CaptureGeometryContext): Rect {
  const origin = capturePointToPage({ x: rect.x, y: rect.y }, context);
  return { ...rect, x: origin.x, y: origin.y };
}

export function pageRectToCapture(rect: Rect, context: CaptureGeometryContext): Rect {
  const origin = pagePointToCapture({ x: rect.x, y: rect.y }, context);
  return { ...rect, x: origin.x, y: origin.y };
}

export function deriveGeometryFromPageRect(pageRect: Rect, context: CaptureGeometryContext) {
  const captureRect = pageRectToCapture(pageRect, context);
  return {
    pageRect,
    captureRect,
    viewportRect: { ...captureRect }
  };
}

export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x <= rect.x + rect.width && point.y <= rect.y + rect.height;
}

export function rectArea(rect: Rect): number {
  return rect.width * rect.height;
}

export function boundsForPath(path: Point[]): Rect {
  if (path.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = path.map((point) => point.x);
  const ys = path.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function pickDomTarget(targets: DomTargetForPick[], point: Point): DomTargetForPick | undefined {
  return targets
    .filter((target) => rectContainsPoint(target.captureRect, point))
    .sort((a, b) => {
      const areaDelta = rectArea(a.captureRect) - rectArea(b.captureRect);
      if (areaDelta !== 0) return areaDelta;
      return b.selectorScore - a.selectorScore;
    })[0];
}

export function clampSelectorScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}
