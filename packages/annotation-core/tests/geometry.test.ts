import { describe, expect, it } from 'vitest';
import {
  boundsForPath,
  capturePointToPage,
  captureRectToPage,
  deriveGeometryFromPageRect,
  normalizeRect,
  pagePointToCapture,
  pageRectToCapture,
  pickDomTarget,
  rectContainsPoint
} from '../src/index.js';

const viewportContext = { mode: 'viewport' as const, scroll: { x: 0, y: 120 } };
const fullPageContext = { mode: 'fullPage' as const, scroll: { x: 0, y: 120 } };

describe('geometry bootstrap', () => {
  it('normalizes drag rectangles', () => {
    expect(normalizeRect({ x: 10, y: 2 }, { x: 3, y: 9 })).toEqual({ x: 3, y: 2, width: 7, height: 7 });
  });

  it('roundtrips viewport capture coordinates through page coordinates', () => {
    const capture = { x: 12, y: 24 };
    const page = capturePointToPage(capture, viewportContext);
    expect(page).toEqual({ x: 12, y: 144 });
    expect(pagePointToCapture(page, viewportContext)).toEqual(capture);
  });

  it('keeps fullPage capture and page coordinates identical', () => {
    const rect = { x: 3, y: 9, width: 11, height: 15 };
    expect(captureRectToPage(rect, fullPageContext)).toEqual(rect);
    expect(pageRectToCapture(rect, fullPageContext)).toEqual(rect);
  });

  it('derives capture and viewport rects from page rect', () => {
    expect(deriveGeometryFromPageRect({ x: 4, y: 130, width: 20, height: 30 }, viewportContext)).toEqual({
      pageRect: { x: 4, y: 130, width: 20, height: 30 },
      captureRect: { x: 4, y: 10, width: 20, height: 30 },
      viewportRect: { x: 4, y: 10, width: 20, height: 30 }
    });
  });

  it('hit-tests rects inclusively', () => {
    expect(rectContainsPoint({ x: 4, y: 5, width: 10, height: 12 }, { x: 14, y: 17 })).toBe(true);
  });

  it('computes freehand path bounds', () => {
    expect(boundsForPath([{ x: 4, y: 8 }, { x: 1, y: 11 }, { x: 7, y: 3 }])).toEqual({ x: 1, y: 3, width: 6, height: 8 });
  });

  it('picks the smallest matching target and uses selector score as tiebreaker', () => {
    const targets = [
      { id: 'large', captureRect: { x: 0, y: 0, width: 100, height: 100 }, selectorScore: 100 },
      { id: 'small-low', captureRect: { x: 10, y: 10, width: 20, height: 20 }, selectorScore: 50 },
      { id: 'small-high', captureRect: { x: 10, y: 10, width: 20, height: 20 }, selectorScore: 90 }
    ];
    expect(pickDomTarget(targets, { x: 15, y: 15 })?.id).toBe('small-high');
  });
});
