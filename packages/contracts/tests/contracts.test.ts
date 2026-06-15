import { describe, expect, it } from 'vitest';
import {
  bugClarificationRequestSchema,
  bugRequirementDraftSchema,
  domTargetSchema,
  healthResponseSchema,
  markitActionRequestSchema,
  markitAnnotationSchema,
  markitBugSchema,
  markitCaptureSchema,
  markitSessionSchema,
  rectSchema,
  viewportPresets,
  viewportSchema,
  type Rect
} from '../src/index.js';

const now = '2026-06-15T10:00:00.000Z';
const viewport = viewportPresets[4]!;
const rect: Rect = { x: 1, y: 2, width: 3, height: 4 };
const target = {
  id: 'target_1',
  selector: '[data-testid="save"]',
  selectorKind: 'testid',
  selectorScore: 100,
  tagName: 'button',
  label: 'Save',
  text: 'Save',
  htmlHint: '<button>Save</button>',
  pageRect: rect,
  viewportRect: rect,
  captureRect: rect,
  visible: true
};

describe('core DTO contracts', () => {
  it('validates viewport presets from implementation plan', () => {
    expect(viewportPresets.map((item) => item.name)).toContain('Mobile 390x844');
    expect(viewportPresets.every((item) => viewportSchema.safeParse(item).success)).toBe(true);
  });

  it('validates session and capture payloads', () => {
    expect(markitSessionSchema.parse({
      id: 'ses_1',
      sourceUrl: 'https://example.com',
      currentUrl: 'https://example.com/home',
      title: 'Example',
      viewport,
      sessionVersion: 1,
      runtimeStatus: 'active',
      createdAt: now,
      updatedAt: now
    }).sessionVersion).toBe(1);

    expect(markitCaptureSchema.parse({
      id: 'cap_1',
      sessionId: 'ses_1',
      sessionVersion: 1,
      url: 'https://example.com',
      finalUrl: 'https://example.com/home',
      title: 'Example',
      viewport,
      scroll: { x: 0, y: 10 },
      mode: 'viewport',
      screenshotPath: '.markit/captures/cap_1/screenshot.png',
      domTargetsPath: '.markit/captures/cap_1/dom-targets.json',
      imageSize: { width: 390, height: 844 },
      createdAt: now
    }).mode).toBe('viewport');
  });

  it('validates DOM target, annotation, and bug payloads', () => {
    expect(domTargetSchema.parse(target).selectorScore).toBe(100);
    expect(markitAnnotationSchema.parse({
      id: 'ann_1',
      captureId: 'cap_1',
      kind: 'element',
      geometry: { pageRect: rect, captureRect: rect, viewportRect: rect },
      target,
      note: 'button is hidden',
      colorRole: 'bug',
      createdAt: now,
      updatedAt: now
    }).kind).toBe('element');
    expect(markitBugSchema.parse({
      id: 'bug_1',
      sessionId: 'ses_1',
      title: 'Menu hidden',
      actual: 'The menu is clipped.',
      expected: 'The menu is fully visible.',
      severity: 'P1',
      status: 'draft',
      sourceUrl: 'https://example.com',
      finalUrl: 'https://example.com/home',
      primaryCaptureId: 'cap_1',
      tags: [],
      createdAt: now,
      updatedAt: now
    }).severity).toBe('P1');
  });
});

describe('API and AI contracts', () => {
  it('defaults action recapture to true', () => {
    expect(markitActionRequestSchema.parse({ baseSessionVersion: 1, type: 'reload' }).recapture).toBe(true);
  });

  it('validates AI draft and clarification contracts', () => {
    const draft = bugRequirementDraftSchema.parse({
      title: 'Button clipped',
      problemType: 'visual',
      severity: 'P1',
      actual: 'Button is clipped.',
      expected: 'Button should be visible.',
      affectedArea: 'Header',
      reproSteps: ['Open mobile viewport'],
      acceptanceCriteria: ['Button visible at 390x844'],
      openQuestions: [],
      confidence: 0.99,
      fieldConfidence: {
        title: 1,
        problemType: 1,
        severity: 1,
        actual: 1,
        expected: 1,
        affectedArea: 1,
        reproSteps: 1,
        acceptanceCriteria: 1
      }
    });
    expect(draft.confidence).toBe(0.99);
    expect(bugClarificationRequestSchema.parse({
      kind: 'clarification_required',
      questions: [{ id: 'q1', question: 'What should happen?', reason: 'missing_expected' }],
      partialDraft: { title: 'Button clipped' }
    }).questions).toHaveLength(1);
  });

  it('validates health response shape', () => {
    expect(healthResponseSchema.parse({ ok: true, name: 'markit-server', version: '0.1.0', time: now }).ok).toBe(true);
  });
});
