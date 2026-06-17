import { z } from 'zod';

export const rectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().nonnegative(),
  height: z.number().finite().nonnegative()
});
export type Rect = z.infer<typeof rectSchema>;

export const pointSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
export type Point = z.infer<typeof pointSchema>;

export const viewportSchema = z.object({
  name: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive(),
  isMobile: z.boolean().optional()
});
export type Viewport = z.infer<typeof viewportSchema>;

export const viewportPresets = [
  { name: 'Desktop 1440x900', width: 1440, height: 900, deviceScaleFactor: 1 },
  { name: 'Laptop 1366x768', width: 1366, height: 768, deviceScaleFactor: 1 },
  { name: 'Tablet 820x1180', width: 820, height: 1180, deviceScaleFactor: 2, isMobile: true },
  { name: 'Mobile 430x932', width: 430, height: 932, deviceScaleFactor: 3, isMobile: true },
  { name: 'Mobile 390x844', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true },
  { name: 'Mobile 360x800', width: 360, height: 800, deviceScaleFactor: 3, isMobile: true }
] satisfies Viewport[];

export const sessionStatusSchema = z.enum(['active', 'inactive', 'expired', 'archived', 'error']);
export const projectSnapshotSchema = z.object({
  schema: z.literal('markit.project-snapshot.v1'),
  source: z.enum(['client', 'catalog-resolve']),
  capturedAt: z.string().datetime(),
  catalogRoot: z.string().optional(),
  catalogGeneratedAt: z.string().datetime().optional(),
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: z.string(),
    scmpService: z.string().optional(),
    gitlabPath: z.string().optional(),
    activeBranch: z.string().optional(),
    issueProjectPath: z.string().optional(),
    defaultAssignee: z.string().optional(),
    labels: z.array(z.string()).optional(),
    confidence: z.number().min(0).max(1).optional()
  }),
  domain: z.object({
    host: z.string().min(1),
    url: z.string().url(),
    env: z.string(),
    status: z.string(),
    matchedHost: z.string().optional()
  }).optional()
});
export type ProjectSnapshot = z.infer<typeof projectSnapshotSchema>;

export const markitSessionSchema = z.object({
  id: z.string().min(1),
  sourceUrl: z.string().url(),
  currentUrl: z.string().url(),
  title: z.string(),
  viewport: viewportSchema,
  projectSnapshot: projectSnapshotSchema.optional(),
  sessionVersion: z.number().int().nonnegative(),
  runtimeStatus: sessionStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type MarkitSession = z.infer<typeof markitSessionSchema>;

export const captureModeSchema = z.enum(['viewport', 'fullPage']);
export const markitCaptureSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  sessionVersion: z.number().int().nonnegative(),
  url: z.string().url(),
  finalUrl: z.string().url(),
  title: z.string(),
  viewport: viewportSchema,
  scroll: pointSchema,
  mode: captureModeSchema,
  screenshotPath: z.string().min(1),
  domTargetsPath: z.string().min(1),
  imageSize: z.object({ width: z.number().positive(), height: z.number().positive() }),
  createdAt: z.string().datetime()
});
export type MarkitCapture = z.infer<typeof markitCaptureSchema>;

export const selectorKindSchema = z.enum(['testid', 'aria', 'id', 'css-path', 'text-fallback']);
export const domTargetSchema = z.object({
  id: z.string().min(1),
  selector: z.string().min(1),
  selectorKind: selectorKindSchema,
  selectorScore: z.number().min(0).max(100),
  tagName: z.string().min(1),
  role: z.string().optional(),
  label: z.string(),
  text: z.string(),
  value: z.string().optional(),
  htmlHint: z.string(),
  pageRect: rectSchema,
  viewportRect: rectSchema,
  captureRect: rectSchema,
  visible: z.boolean()
});
export type DomTarget = z.infer<typeof domTargetSchema>;

export const annotationKindSchema = z.enum(['pin', 'rect', 'ellipse', 'freehand', 'element', 'section']);
export const annotationGeometrySchema = z.object({
  pageRect: rectSchema,
  captureRect: rectSchema,
  viewportRect: rectSchema,
  paths: z.array(z.array(pointSchema)).optional()
});
export type AnnotationGeometry = z.infer<typeof annotationGeometrySchema>;

export const colorRoleSchema = z.enum(['bug', 'note', 'selected', 'resolved']);
export const markitAnnotationSchema = z.object({
  id: z.string().min(1),
  captureId: z.string().min(1),
  kind: annotationKindSchema,
  geometry: annotationGeometrySchema,
  target: domTargetSchema.optional(),
  note: z.string(),
  colorRole: colorRoleSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type MarkitAnnotation = z.infer<typeof markitAnnotationSchema>;

export const severitySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export const bugStatusSchema = z.enum(['draft', 'open', 'resolved', 'wontfix']);
export const bugReferenceKindSchema = z.enum(['requirement', 'design', 'compare', 'other']);
export const bugReferenceSchema = z.object({
  kind: bugReferenceKindSchema,
  url: z.string().url(),
  label: z.string().optional()
});
export type BugReference = z.infer<typeof bugReferenceSchema>;
export const bugAssetKindSchema = z.enum(['pasted-screenshot', 'uploaded-screenshot', 'compare-image', 'other']);
export const markitBugAssetSchema = z.object({
  id: z.string().min(1),
  bugId: z.string().min(1),
  kind: bugAssetKindSchema,
  fileName: z.string().min(1),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  sizeBytes: z.number().int().positive(),
  label: z.string().optional(),
  createdAt: z.string().datetime()
});
export type MarkitBugAsset = z.infer<typeof markitBugAssetSchema>;
export const markitBugSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  title: z.string(),
  actual: z.string(),
  expected: z.string(),
  severity: severitySchema,
  status: bugStatusSchema,
  sourceUrl: z.string().url(),
  finalUrl: z.string().url(),
  primaryCaptureId: z.string().optional(),
  tags: z.array(z.string()),
  references: z.array(bugReferenceSchema),
  exportPath: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type MarkitBug = z.infer<typeof markitBugSchema>;

export const markitBugAnnotationSchema = z.object({
  bugId: z.string().min(1),
  annotationId: z.string().min(1),
  sortOrder: z.number().int().nonnegative()
});
export type MarkitBugAnnotation = z.infer<typeof markitBugAnnotationSchema>;

export const actionTypeSchema = z.enum(['click', 'scroll', 'type', 'key', 'reload', 'back', 'forward']);
export const markitActionRequestSchema = z.object({
  baseSessionVersion: z.number().int().nonnegative(),
  type: actionTypeSchema,
  point: pointSchema.optional(),
  delta: pointSchema.optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
  key: z.string().optional(),
  recapture: z.boolean().default(true)
});
export type MarkitActionRequest = z.input<typeof markitActionRequestSchema>;

export const markitActionResponseSchema = z.object({
  staleBase: z.boolean(),
  session: markitSessionSchema.optional(),
  capture: markitCaptureSchema.optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional()
});
export type MarkitActionResponse = z.infer<typeof markitActionResponseSchema>;

export const problemTypeSchema = z.enum(['visual', 'layout', 'interaction', 'copy', 'data', 'performance', 'other']);
const draftFieldSchema = z.enum(['title', 'problemType', 'severity', 'actual', 'expected', 'affectedArea', 'reproSteps', 'acceptanceCriteria']);
export const bugRequirementDraftSchema = z.object({
  title: z.string(),
  problemType: problemTypeSchema,
  severity: severitySchema,
  actual: z.string(),
  expected: z.string(),
  affectedArea: z.string(),
  reproSteps: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()),
  openQuestions: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  fieldConfidence: z.record(draftFieldSchema, z.number().min(0).max(1))
});
export type BugRequirementDraft = z.infer<typeof bugRequirementDraftSchema>;

export const bugClarificationRequestSchema = z.object({
  kind: z.literal('clarification_required'),
  questions: z.array(z.object({
    id: z.string().min(1),
    question: z.string().min(1),
    reason: z.enum(['missing_actual', 'missing_expected', 'ambiguous_target', 'severity_unclear', 'scope_unclear']),
    suggestions: z.array(z.string()).optional()
  })).max(3),
  partialDraft: bugRequirementDraftSchema.partial()
});
export type BugClarificationRequest = z.infer<typeof bugClarificationRequestSchema>;

export const normalizeBugRequestSchema = z.object({
  sessionId: z.string().min(1),
  bugId: z.string().optional(),
  captureId: z.string().min(1),
  annotationIds: z.array(z.string()),
  sourceText: z.string(),
  strictness: z.enum(['strict', 'draft']),
  existingDraft: bugRequirementDraftSchema.partial().optional(),
  clarificationAnswers: z.array(z.object({ questionId: z.string(), answer: z.string() })).optional(),
  includeCropImages: z.boolean().optional(),
  assets: z.array(z.object({
    label: z.string().optional(),
    fileName: z.string().min(1),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    dataUrl: z.string().regex(/^data:image\/(png|jpeg|webp);base64,/i)
  })).max(8).optional()
});
export type NormalizeBugRequest = z.infer<typeof normalizeBugRequestSchema>;

export const normalizeBugResponseSchema = z.union([
  z.object({ kind: z.literal('draft'), draft: bugRequirementDraftSchema, modelTraceId: z.string(), unresolvedFields: z.array(z.string()) }),
  bugClarificationRequestSchema.extend({ modelTraceId: z.string(), unresolvedFields: z.array(z.string()) })
]);
export type NormalizeBugResponse = z.infer<typeof normalizeBugResponseSchema>;

export const healthResponseSchema = z.object({
  ok: z.literal(true),
  name: z.literal('markit-server'),
  version: z.string(),
  time: z.string().datetime()
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
