import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { Router } from 'express';
import type { ServerContext } from '../context.js';
import { MarkitHttpError } from '../url-safety.js';
import { all, asyncHandler, first, nowIso, parseJson, type Row } from './helpers.js';
import { mapAnnotation, mapBug, mapCapture } from './mappers.js';

export function bugsRouter(context: ServerContext): Router {
  const router = Router();

  router.get('/api/bugs', (req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    const rows = status && status !== 'all'
      ? all(context.database.db, 'SELECT * FROM bugs WHERE status = ? ORDER BY created_at DESC', [status])
      : all(context.database.db, 'SELECT * FROM bugs ORDER BY created_at DESC');
    res.json({ bugs: rows.map((row) => ({ ...mapBug(row), annotationCount: countRelations(context, String(row.id)) })) });
  });

  router.post('/api/bugs', asyncHandler(async (req, res) => {
    validateBugInput(req.body);
    const id = `bug_${randomUUID()}`;
    const ts = nowIso();
    context.database.db.run(
      `INSERT INTO bugs (id, session_id, title, actual, expected, severity, status, source_url, final_url, primary_capture_id, tags_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, String(req.body.sessionId), String(req.body.title), String(req.body.actual), String(req.body.expected), String(req.body.severity), String(req.body.status ?? 'draft'), String(req.body.sourceUrl), String(req.body.finalUrl), req.body.primaryCaptureId ? String(req.body.primaryCaptureId) : null, JSON.stringify(req.body.tags ?? []), ts, ts]
    );
    if (Array.isArray(req.body.annotationIds)) {
      req.body.annotationIds.forEach((annotationId: unknown, index: number) => addRelation(context, id, String(annotationId), index));
    }
    await context.database.save();
    res.status(201).json(await bugDetail(context, id));
  }));

  router.get('/api/bugs/:id', asyncHandler(async (req, res) => {
    res.json(await bugDetail(context, String(req.params.id)));
  }));

  router.patch('/api/bugs/:id', asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const bug = first(context.database.db, 'SELECT * FROM bugs WHERE id = ?', [id]);
    if (!bug) throw new MarkitHttpError(404, 'bug_not_found', 'Bug not found');
    context.database.db.run(
      `UPDATE bugs SET title = ?, actual = ?, expected = ?, severity = ?, status = ?, tags_json = ?, updated_at = ? WHERE id = ?`,
      [
        String(req.body?.title ?? bug.title),
        String(req.body?.actual ?? bug.actual),
        String(req.body?.expected ?? bug.expected),
        String(req.body?.severity ?? bug.severity),
        String(req.body?.status ?? bug.status),
        JSON.stringify(req.body?.tags ?? parseJson(bug.tags_json, [])),
        nowIso(),
        id
      ]
    );
    await context.database.save();
    res.json(await bugDetail(context, id));
  }));

  router.post('/api/bugs/:id/annotations', asyncHandler(async (req, res) => {
    const bugId = String(req.params.id);
    const annotationId = String(req.body?.annotationId);
    const sortOrder = Number(req.body?.sortOrder ?? countRelations(context, bugId));
    addRelation(context, bugId, annotationId, sortOrder);
    await context.database.save();
    res.json(await bugDetail(context, bugId));
  }));

  router.delete('/api/bugs/:id/annotations/:annotationId', asyncHandler(async (req, res) => {
    context.database.db.run('DELETE FROM bug_annotations WHERE bug_id = ? AND annotation_id = ?', [String(req.params.id), String(req.params.annotationId)]);
    await context.database.save();
    res.json(await bugDetail(context, String(req.params.id)));
  }));

  router.post('/api/bugs/:id/export', asyncHandler(async (req, res) => {
    const result = await exportBug(context, String(req.params.id));
    await context.database.save();
    res.json(result);
  }));

  return router;
}

function validateBugInput(body: unknown) {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  for (const key of ['sessionId', 'title', 'actual', 'expected', 'severity', 'sourceUrl', 'finalUrl']) {
    if (!input[key] || String(input[key]).trim() === '') {
      throw new MarkitHttpError(400, 'bug_validation_failed', `Missing required field: ${key}`);
    }
  }
}

function addRelation(context: ServerContext, bugId: string, annotationId: string, sortOrder: number) {
  context.database.db.run('INSERT OR REPLACE INTO bug_annotations (bug_id, annotation_id, sort_order) VALUES (?, ?, ?)', [bugId, annotationId, sortOrder]);
}

function countRelations(context: ServerContext, bugId: string): number {
  const row = first(context.database.db, 'SELECT COUNT(*) AS count FROM bug_annotations WHERE bug_id = ?', [bugId]);
  return Number(row?.count ?? 0);
}

async function bugDetail(context: ServerContext, id: string) {
  const bug = first(context.database.db, 'SELECT * FROM bugs WHERE id = ?', [id]);
  if (!bug) throw new MarkitHttpError(404, 'bug_not_found', 'Bug not found');
  const relationRows = all(context.database.db, 'SELECT * FROM bug_annotations WHERE bug_id = ? ORDER BY sort_order ASC', [id]);
  const annotations = relationRows.map((relation) => {
    const annotation = first(context.database.db, 'SELECT * FROM annotations WHERE id = ?', [String(relation.annotation_id)]);
    return annotation ? { ...mapAnnotation(annotation), sortOrder: Number(relation.sort_order) } : undefined;
  }).filter(Boolean);
  const captures = unique(annotations.map((annotation) => String((annotation as { captureId: string }).captureId))).map((captureId) => {
    const capture = first(context.database.db, 'SELECT * FROM captures WHERE id = ?', [captureId]);
    return capture ? mapCapture(capture) : undefined;
  }).filter(Boolean);
  return { bug: { ...mapBug(bug), annotationCount: annotations.length }, annotations, captures };
}

async function exportBug(context: ServerContext, id: string) {
  const detail = await bugDetail(context, id);
  const exportDir = join(context.dataDir, 'exports', id);
  await mkdir(join(exportDir, 'captures'), { recursive: true });
  const groups = new Map<string, Row[]>();
  for (const annotation of detail.annotations as Array<{ id: string; captureId: string }>) {
    const row = first(context.database.db, 'SELECT * FROM annotations WHERE id = ?', [annotation.id]);
    if (!row) continue;
    const list = groups.get(annotation.captureId) ?? [];
    list.push(row);
    groups.set(annotation.captureId, list);
  }
  for (const [captureId, annotations] of groups.entries()) {
    const capture = first(context.database.db, 'SELECT * FROM captures WHERE id = ?', [captureId]);
    if (!capture) continue;
    const captureDir = join(exportDir, 'captures', captureId);
    const cropDir = join(captureDir, 'crops');
    await mkdir(cropDir, { recursive: true });
    const png = PNG.sync.read(await readFile(String(capture.screenshot_path)));
    for (const annotation of annotations) {
      drawAnnotation(png, annotation);
      await writeCrop(png, annotation, join(cropDir, `${annotation.id}.png`));
    }
    await writeFile(join(captureDir, 'screenshot.annotated.png'), PNG.sync.write(png));
    await writeFile(join(captureDir, 'metadata.json'), JSON.stringify(mapCapture(capture), null, 2));
    await writeFile(join(captureDir, 'dom-targets.json'), await readFile(String(capture.dom_targets_path), 'utf8'));
  }
  const markdown = renderMarkdown(detail, groups);
  await writeFile(join(exportDir, 'bug.md'), markdown);
  await writeFile(join(exportDir, 'bug.json'), JSON.stringify(detail, null, 2));
  context.database.db.run('UPDATE bugs SET export_path = ?, updated_at = ? WHERE id = ?', [exportDir, nowIso(), id]);
  return { exportPath: exportDir, markdown };
}

function renderMarkdown(detail: { bug: ReturnType<typeof mapBug>; annotations: unknown[] }, groups: Map<string, Row[]>): string {
  const bug = detail.bug;
  return `# ${bug.title}\n\n- Severity: ${bug.severity}\n- Status: ${bug.status}\n- Source URL: ${bug.sourceUrl}\n- Final URL: ${bug.finalUrl}\n\n## Actual\n\n${bug.actual}\n\n## Expected\n\n${bug.expected}\n\n## Annotations\n\n${[...groups.entries()].map(([captureId, annotations]) => `### ${captureId}\n\n${annotations.map((annotation) => `- ${annotation.id}: ${annotation.note}`).join('\n')}`).join('\n\n')}\n`;
}

function drawAnnotation(png: PNG, annotation: Row) {
  const geometry = parseJson<{ captureRect: { x: number; y: number; width: number; height: number }; paths?: Array<Array<{ x: number; y: number }>> }>(annotation.geometry_json, { captureRect: { x: 0, y: 0, width: 1, height: 1 } });
  const rect = geometry.captureRect;
  if (String(annotation.kind) === 'freehand' && geometry.paths) {
    for (const path of geometry.paths) for (const point of path) putDot(png, Math.round(point.x), Math.round(point.y), [229, 72, 77, 255], 2);
    return;
  }
  const x1 = Math.max(0, Math.round(rect.x));
  const y1 = Math.max(0, Math.round(rect.y));
  const x2 = Math.min(png.width - 1, Math.round(rect.x + Math.max(rect.width, 8)));
  const y2 = Math.min(png.height - 1, Math.round(rect.y + Math.max(rect.height, 8)));
  for (let x = x1; x <= x2; x++) {
    putPixel(png, x, y1, [229, 72, 77, 255]);
    putPixel(png, x, y2, [229, 72, 77, 255]);
  }
  for (let y = y1; y <= y2; y++) {
    putPixel(png, x1, y, [229, 72, 77, 255]);
    putPixel(png, x2, y, [229, 72, 77, 255]);
  }
  if (String(annotation.kind) === 'pin') putDot(png, x1, y1, [245, 158, 11, 255], 5);
}

async function writeCrop(png: PNG, annotation: Row, path: string) {
  const geometry = parseJson<{ captureRect: { x: number; y: number; width: number; height: number } }>(annotation.geometry_json, { captureRect: { x: 0, y: 0, width: 32, height: 32 } });
  const rect = geometry.captureRect;
  const pad = 16;
  const x = Math.max(0, Math.floor(rect.x - pad));
  const y = Math.max(0, Math.floor(rect.y - pad));
  const width = Math.min(png.width - x, Math.max(32, Math.ceil(rect.width + pad * 2)));
  const height = Math.min(png.height - y, Math.max(32, Math.ceil(rect.height + pad * 2)));
  const crop = new PNG({ width, height });
  PNG.bitblt(png, crop, x, y, width, height, 0, 0);
  await writeFile(path, PNG.sync.write(crop));
}

function putDot(png: PNG, x: number, y: number, rgba: [number, number, number, number], radius: number) {
  for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
    if (dx * dx + dy * dy <= radius * radius) putPixel(png, x + dx, y + dy, rgba);
  }
}

function putPixel(png: PNG, x: number, y: number, rgba: [number, number, number, number]) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const index = (png.width * y + x) << 2;
  png.data[index] = rgba[0];
  png.data[index + 1] = rgba[1];
  png.data[index + 2] = rgba[2];
  png.data[index + 3] = rgba[3];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
