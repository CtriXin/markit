import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { PNG } from 'pngjs';
import { Router } from 'express';
import type { ServerContext } from '../context.js';
import { MarkitHttpError } from '../url-safety.js';
import { all, asyncHandler, first, nowIso, parseJson, type Row } from './helpers.js';
import { mapAnnotation, mapBug, mapBugAsset, mapCapture } from './mappers.js';

const maxAssetBytes = 8 * 1024 * 1024;
const allowedAssetTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function bugsRouter(context: ServerContext): Router {
  const router = Router();

  router.get('/api/bugs', (req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    const rows = status && status !== 'all'
      ? all(context.database.db, 'SELECT * FROM bugs WHERE status = ? ORDER BY created_at DESC', [status])
      : all(context.database.db, 'SELECT * FROM bugs ORDER BY created_at DESC');
    res.json({ bugs: rows.map((row) => ({ ...mapBug(row), annotationCount: countRelations(context, String(row.id)), assetCount: countAssets(context, String(row.id)) })) });
  });

  router.post('/api/bugs', asyncHandler(async (req, res) => {
    validateBugInput(req.body);
    const id = `bug_${randomUUID()}`;
    const ts = nowIso();
    context.database.db.run(
      `INSERT INTO bugs (id, session_id, title, actual, expected, severity, status, source_url, final_url, primary_capture_id, tags_json, references_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, String(req.body.sessionId), String(req.body.title), String(req.body.actual), String(req.body.expected), String(req.body.severity), String(req.body.status ?? 'draft'), String(req.body.sourceUrl), String(req.body.finalUrl), req.body.primaryCaptureId ? String(req.body.primaryCaptureId) : null, JSON.stringify(req.body.tags ?? []), JSON.stringify(normalizeReferences(req.body.references)), ts, ts]
    );
    if (Array.isArray(req.body.annotationIds)) {
      req.body.annotationIds.forEach((annotationId: unknown, index: number) => addRelation(context, id, String(annotationId), index));
    }
    await persistBugAssets(context, id, req.body.assets);
    await context.database.save();
    res.status(201).json(await bugDetail(context, id));
  }));

  router.get('/api/bugs/:id', asyncHandler(async (req, res) => {
    res.json(await bugDetail(context, String(req.params.id)));
  }));

  router.get('/api/bug-assets/:id/image', asyncHandler(async (req, res) => {
    const asset = first(context.database.db, 'SELECT * FROM bug_assets WHERE id = ?', [String(req.params.id)]);
    if (!asset) throw new MarkitHttpError(404, 'bug_asset_not_found', 'Bug asset not found');
    res.type(String(asset.mime_type));
    res.send(await readFile(String(asset.file_path)));
  }));

  router.patch('/api/bugs/:id', asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const bug = first(context.database.db, 'SELECT * FROM bugs WHERE id = ?', [id]);
    if (!bug) throw new MarkitHttpError(404, 'bug_not_found', 'Bug not found');
    context.database.db.run(
      `UPDATE bugs SET title = ?, actual = ?, expected = ?, severity = ?, status = ?, tags_json = ?, references_json = ?, updated_at = ? WHERE id = ?`,
      [
        String(req.body?.title ?? bug.title),
        String(req.body?.actual ?? bug.actual),
        String(req.body?.expected ?? bug.expected),
        String(req.body?.severity ?? bug.severity),
        String(req.body?.status ?? bug.status),
        JSON.stringify(req.body?.tags ?? parseJson(bug.tags_json, [])),
        JSON.stringify(req.body?.references ? normalizeReferences(req.body.references) : parseJson(bug.references_json, [])),
        nowIso(),
        id
      ]
    );
    await context.database.save();
    res.json(await bugDetail(context, id));
  }));

  router.delete('/api/bugs/:id', asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const bug = first(context.database.db, 'SELECT * FROM bugs WHERE id = ?', [id]);
    if (!bug) throw new MarkitHttpError(404, 'bug_not_found', 'Bug not found');
    const jobs = all(context.database.db, 'SELECT id FROM ai_jobs WHERE bug_id = ?', [id]).map((row) => String(row.id));
    if (jobs.length) {
      const placeholders = jobs.map(() => '?').join(', ');
      context.database.db.run(`DELETE FROM ai_runs WHERE job_id IN (${placeholders})`, jobs);
    }
    context.database.db.run('DELETE FROM ai_jobs WHERE bug_id = ?', [id]);
    context.database.db.run('DELETE FROM bug_annotations WHERE bug_id = ?', [id]);
    context.database.db.run('DELETE FROM bug_assets WHERE bug_id = ?', [id]);
    context.database.db.run('DELETE FROM bugs WHERE id = ?', [id]);
    await Promise.all([
      rm(join(context.dataDir, 'assets', 'bugs', id), { recursive: true, force: true }),
      rm(join(context.dataDir, 'exports', id), { recursive: true, force: true })
    ]);
    await context.database.save();
    res.json({ ok: true });
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

function normalizeReferences(value: unknown): Array<{ kind: string; url: string; label?: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item && typeof item === 'object' ? item : {}) as Record<string, unknown>)
    .filter((item) => typeof item.url === 'string' && /^https?:\/\//i.test(item.url.trim()))
    .map((item) => ({
      kind: String(item.kind ?? 'other').slice(0, 40),
      url: String(item.url).trim(),
      ...(item.label ? { label: String(item.label).slice(0, 80) } : {})
    }));
}

function addRelation(context: ServerContext, bugId: string, annotationId: string, sortOrder: number) {
  context.database.db.run('INSERT OR REPLACE INTO bug_annotations (bug_id, annotation_id, sort_order) VALUES (?, ?, ?)', [bugId, annotationId, sortOrder]);
}

function countRelations(context: ServerContext, bugId: string): number {
  const row = first(context.database.db, 'SELECT COUNT(*) AS count FROM bug_annotations WHERE bug_id = ?', [bugId]);
  return Number(row?.count ?? 0);
}

function countAssets(context: ServerContext, bugId: string): number {
  const row = first(context.database.db, 'SELECT COUNT(*) AS count FROM bug_assets WHERE bug_id = ?', [bugId]);
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
  const assets = await assetsForBug(context, id);
  const session = first(context.database.db, 'SELECT * FROM sessions WHERE id = ?', [String(bug.session_id)]);
  const projectSnapshot = session ? parseJson(session.project_snapshot_json, undefined) : undefined;
  return { bug: { ...mapBug(bug), annotationCount: annotations.length, assetCount: assets.length }, annotations, captures, assets, projectSnapshot };
}

async function assetsForBug(context: ServerContext, id: string) {
  return all(context.database.db, 'SELECT * FROM bug_assets WHERE bug_id = ? ORDER BY created_at ASC', [id]).map(mapBugAsset);
}

async function persistBugAssets(context: ServerContext, bugId: string, value: unknown) {
  if (!Array.isArray(value)) return;
  const assetsDir = join(context.dataDir, 'assets', 'bugs', bugId);
  await mkdir(assetsDir, { recursive: true });
  for (const raw of value.slice(0, 8)) {
    const input = normalizeAssetInput(raw);
    if (!input) continue;
    const id = `asset_${randomUUID()}`;
    const extension = extensionForMime(input.mimeType, input.fileName);
    const fileName = `${id}${extension}`;
    const filePath = join(assetsDir, fileName);
    await writeFile(filePath, input.buffer);
    context.database.db.run(
      `INSERT INTO bug_assets (id, bug_id, kind, file_name, mime_type, size_bytes, file_path, label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, bugId, input.kind, input.fileName, input.mimeType, input.buffer.length, filePath, input.label || null, nowIso()]
    );
  }
}

function normalizeAssetInput(value: unknown): { kind: string; fileName: string; mimeType: string; label: string; buffer: Buffer } | undefined {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const mimeType = String(input.mimeType ?? '').toLowerCase();
  if (!allowedAssetTypes.has(mimeType)) return undefined;
  const dataUrl = String(input.dataUrl ?? '');
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match || match[1]?.toLowerCase() !== mimeType) return undefined;
  const buffer = Buffer.from(match[2] ?? '', 'base64');
  if (!buffer.length || buffer.length > maxAssetBytes) return undefined;
  return {
    kind: String(input.kind ?? 'compare-image').slice(0, 40),
    fileName: sanitizeFileName(String(input.fileName ?? `screenshot.${extensionForMime(mimeType).slice(1)}`)),
    mimeType,
    label: String(input.label ?? '').slice(0, 100),
    buffer
  };
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^\w.\-()\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'screenshot.png';
}

function extensionForMime(mimeType: string, fileName = ''): string {
  const current = extname(fileName).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(current)) return current;
  if (mimeType === 'image/jpeg') return '.jpg';
  if (mimeType === 'image/webp') return '.webp';
  return '.png';
}

async function exportBug(context: ServerContext, id: string) {
  const detail = await bugDetail(context, id);
  const exportDir = join(context.dataDir, 'exports', id);
  await mkdir(join(exportDir, 'captures'), { recursive: true });
  await mkdir(join(exportDir, 'assets'), { recursive: true });
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
  const assets = await assetsForBug(context, id);
  for (const asset of assets) {
    const row = first(context.database.db, 'SELECT * FROM bug_assets WHERE id = ?', [asset.id]);
    if (!row) continue;
    await copyFile(String(row.file_path), join(exportDir, 'assets', exportedAssetName(asset)));
  }
  const markdown = renderMarkdown(detail, groups);
  await writeFile(join(exportDir, 'bug.md'), markdown);
  await writeFile(join(exportDir, 'bug.json'), JSON.stringify(detail, null, 2));
  context.database.db.run('UPDATE bugs SET export_path = ?, updated_at = ? WHERE id = ?', [exportDir, nowIso(), id]);
  return { exportPath: exportDir, markdown };
}

function renderMarkdown(detail: { bug: ReturnType<typeof mapBug>; annotations: unknown[]; assets?: ReturnType<typeof mapBugAsset>[]; projectSnapshot?: any }, groups: Map<string, Row[]>): string {
  const bug = detail.bug;
  const project = detail.projectSnapshot?.project;
  const domain = detail.projectSnapshot?.domain;
  const projectLines = project
    ? `- Project: ${project.name} (${project.id})\n- Domain: ${domain?.host ?? 'none'}${domain?.status ? ` / ${domain.status}` : ''}\n- Branch: ${project.activeBranch ?? 'none'}\n- GitLab: ${project.issueProjectPath ?? project.gitlabPath ?? 'none'}\n`
    : '';
  const references = bug.references.length
    ? `\n## References\n\n${bug.references.map((reference) => `- ${reference.label ?? reference.kind}: ${reference.url}`).join('\n')}\n`
    : '';
  const assets = detail.assets?.length
    ? `\n## Compare Screenshots\n\n${detail.assets.map((asset) => `- ${asset.label || asset.kind}: [${asset.fileName}](assets/${exportedAssetName(asset)})`).join('\n')}\n`
    : '';
  return `# ${bug.title}\n\n- Severity: ${bug.severity}\n- Status: ${bug.status}\n- Source URL: ${bug.sourceUrl}\n- Final URL: ${bug.finalUrl}\n${projectLines}- Tags: ${bug.tags.join(', ') || 'none'}\n\n## Actual\n\n${bug.actual}\n\n## Expected\n\n${bug.expected}\n${references}${assets}\n## Annotations\n\n${[...groups.entries()].map(([captureId, annotations]) => `### ${captureId}\n\n${annotations.map((annotation) => `- ${annotation.id}: ${annotation.note}`).join('\n')}`).join('\n\n')}\n`;
}

function exportedAssetName(asset: ReturnType<typeof mapBugAsset>): string {
  return `${asset.id}-${asset.fileName}`;
}

function drawAnnotation(png: PNG, annotation: Row) {
  const geometry = parseJson<{ captureRect: { x: number; y: number; width: number; height: number }; paths?: Array<Array<{ x: number; y: number }>> }>(annotation.geometry_json, { captureRect: { x: 0, y: 0, width: 1, height: 1 } });
  const rect = geometry.captureRect;
  if (String(annotation.kind) === 'freehand' && geometry.paths) {
    for (const path of geometry.paths) for (const point of path) putDot(png, Math.round(point.x), Math.round(point.y), [229, 72, 77, 255], 2);
    return;
  }
  if (String(annotation.kind) === 'ellipse') {
    drawEllipse(png, rect, [229, 72, 77, 255]);
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

function drawEllipse(png: PNG, rect: { x: number; y: number; width: number; height: number }, rgba: [number, number, number, number]) {
  const rx = Math.max(4, rect.width / 2);
  const ry = Math.max(4, rect.height / 2);
  const cx = rect.x + rx;
  const cy = rect.y + ry;
  const steps = Math.max(48, Math.ceil(Math.max(rx, ry) * 2));
  for (let index = 0; index <= steps; index += 1) {
    const theta = (Math.PI * 2 * index) / steps;
    putDot(png, Math.round(cx + Math.cos(theta) * rx), Math.round(cy + Math.sin(theta) * ry), rgba, 2);
  }
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
