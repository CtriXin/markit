import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { ServerContext } from '../context.js';
import { MarkitHttpError } from '../url-safety.js';
import { all, asyncHandler, first, nowIso, parseJson } from './helpers.js';
import { mapAnnotation } from './mappers.js';

type Rect = { x: number; y: number; width: number; height: number };

export function annotationsRouter(context: ServerContext): Router {
  const router = Router();

  router.get('/api/captures/:id/annotations', (req, res) => {
    const captureId = String(req.params.id);
    res.json({ annotations: all(context.database.db, 'SELECT * FROM annotations WHERE capture_id = ? ORDER BY created_at ASC', [captureId]).map(mapAnnotation) });
  });

  router.post('/api/captures/:id/annotations', asyncHandler(async (req, res) => {
    const captureId = String(req.params.id);
    const capture = context.repos.captures.get(captureId);
    if (!capture) throw new MarkitHttpError(404, 'capture_not_found', 'Capture not found');
    const captureRect = parseRect(req.body?.geometry?.captureRect ?? req.body?.captureRect ?? { x: req.body?.x ?? 0, y: req.body?.y ?? 0, width: req.body?.width ?? 1, height: req.body?.height ?? 1 });
    const scroll = { x: Number(capture.scroll_x), y: Number(capture.scroll_y) };
    const mode = String(capture.mode);
    const pageRect = mode === 'fullPage' ? captureRect : { ...captureRect, x: captureRect.x + scroll.x, y: captureRect.y + scroll.y };
    const geometry = {
      pageRect,
      captureRect,
      viewportRect: { ...captureRect },
      paths: req.body?.geometry?.paths
    };
    const id = `ann_${randomUUID()}`;
    const ts = nowIso();
    context.database.db.run(
      `INSERT INTO annotations (id, capture_id, kind, geometry_json, target_json, note, color_role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, captureId, String(req.body?.kind ?? 'pin'), JSON.stringify(geometry), req.body?.target ? JSON.stringify(req.body.target) : null, String(req.body?.note ?? ''), String(req.body?.colorRole ?? 'bug'), ts, ts]
    );
    await context.database.save();
    res.status(201).json({ annotation: mapAnnotation(first(context.database.db, 'SELECT * FROM annotations WHERE id = ?', [id])!) });
  }));

  router.patch('/api/annotations/:id', asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const current = first(context.database.db, 'SELECT * FROM annotations WHERE id = ?', [id]);
    if (!current) throw new MarkitHttpError(404, 'annotation_not_found', 'Annotation not found');
    const geometry = req.body?.geometry ? JSON.stringify(req.body.geometry) : String(current.geometry_json);
    context.database.db.run(
      'UPDATE annotations SET note = ?, color_role = ?, geometry_json = ?, updated_at = ? WHERE id = ?',
      [String(req.body?.note ?? current.note ?? ''), String(req.body?.colorRole ?? current.color_role ?? 'bug'), geometry, nowIso(), id]
    );
    await context.database.save();
    res.json({ annotation: mapAnnotation(first(context.database.db, 'SELECT * FROM annotations WHERE id = ?', [id])!) });
  }));

  router.delete('/api/annotations/:id', asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    context.database.db.run('DELETE FROM bug_annotations WHERE annotation_id = ?', [id]);
    context.database.db.run('DELETE FROM annotations WHERE id = ?', [id]);
    await context.database.save();
    res.json({ ok: true });
  }));

  return router;
}

function parseRect(value: unknown): Rect {
  const rect = (value && typeof value === 'object' ? value : {}) as Partial<Rect>;
  return { x: Number(rect.x ?? 0), y: Number(rect.y ?? 0), width: Number(rect.width ?? 1), height: Number(rect.height ?? 1) };
}
