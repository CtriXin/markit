import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Router } from 'express';

import type { ServerContext } from '../context.js';
import { parseHttpUrl, MarkitHttpError } from '../url-safety.js';
import { capturePage } from '../runtime/capture.js';
import { asyncHandler, first, nowIso } from './helpers.js';
import { mapCapture, mapSession } from './mappers.js';

type Viewport = { name: string; width: number; height: number; deviceScaleFactor: number; isMobile?: boolean };

const defaultViewport: Viewport = { name: 'Mobile 390x844', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true };

export function sessionsRouter(context: ServerContext): Router {
  const router = Router();

  router.post('/api/sessions', asyncHandler(async (req, res) => {
    const url = parseHttpUrl(String(req.body?.url ?? ''));
    const viewport = parseViewport(req.body?.viewport);
    const capturePolicy = req.body?.capturePolicy === 'none' ? 'none' : req.body?.capturePolicy === 'fullPage' ? 'fullPage' : 'viewport';
    const sessionId = `ses_${randomUUID()}`;
    const page = await context.runtime.createPage(sessionId, viewport);
    await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: 30_000 });
    const title = await page.title();
    const finalUrl = page.url();

    context.repos.sessions.insert({
      id: sessionId,
      sourceUrl: url.toString(),
      currentUrl: finalUrl,
      title,
      viewport,
      runtimeStatus: 'active'
    });

    let capture: unknown;
    if (capturePolicy !== 'none') {
      capture = await createCapture(context, sessionId, capturePolicy);
    }
    await context.database.save();
    res.status(201).json({ session: mapSession(context.repos.sessions.get(sessionId)!), capture });
  }));

  router.get('/api/sessions', (_req, res) => {
    res.json({ sessions: context.repos.sessions.list().filter((row) => row.runtime_status !== 'archived').map(mapSession) });
  });

  router.get('/api/sessions/:id', (req, res) => {
    const sessionId = String(req.params.id);
    const row = context.repos.sessions.get(sessionId);
    if (!row) throw new MarkitHttpError(404, 'session_not_found', 'Session not found');
    res.json({ session: mapSession(row) });
  });

  router.get('/api/sessions/:id/captures', (req, res) => {
    const sessionId = String(req.params.id);
    const session = context.repos.sessions.get(sessionId);
    if (!session) throw new MarkitHttpError(404, 'session_not_found', 'Session not found');
    res.json({ captures: context.repos.captures.listBySession(sessionId).map(mapCapture) });
  });

  router.post('/api/sessions/:id/captures', asyncHandler(async (req, res) => {
    const sessionId = String(req.params.id);
    const session = context.repos.sessions.get(sessionId);
    if (!session) throw new MarkitHttpError(404, 'session_not_found', 'Session not found');
    const mode = req.body?.mode === 'fullPage' ? 'fullPage' : 'viewport';
    const capture = await createCapture(context, sessionId, mode);
    await context.database.save();
    res.status(201).json({ capture });
  }));

  router.get('/api/captures/:id', (req, res) => {
    const captureId = String(req.params.id);
    const row = context.repos.captures.get(captureId);
    if (!row) throw new MarkitHttpError(404, 'capture_not_found', 'Capture not found');
    res.json({ capture: mapCapture(row) });
  });

  router.get('/api/captures/:id/image', asyncHandler(async (req, res) => {
    const captureId = String(req.params.id);
    const row = context.repos.captures.get(captureId);
    if (!row) throw new MarkitHttpError(404, 'capture_not_found', 'Capture not found');
    res.type('png').send(await readFile(String(row.screenshot_path)));
  }));

  router.get('/api/captures/:id/dom-targets', asyncHandler(async (req, res) => {
    const captureId = String(req.params.id);
    const row = context.repos.captures.get(captureId);
    if (!row) throw new MarkitHttpError(404, 'capture_not_found', 'Capture not found');
    res.type('json').send(await readFile(String(row.dom_targets_path), 'utf8'));
  }));


  router.post('/api/sessions/:id/actions', asyncHandler(async (req, res) => {
    const sessionId = String(req.params.id);
    const session = context.repos.sessions.get(sessionId);
    if (!session) throw new MarkitHttpError(404, 'session_not_found', 'Session not found');
    const page = context.runtime.getPage(sessionId);
    if (!page) throw new MarkitHttpError(409, 'session_inactive', 'Session runtime page is inactive');
    const baseSessionVersion = Number(req.body?.baseSessionVersion ?? session.session_version);
    if (baseSessionVersion !== Number(session.session_version)) {
      res.status(409).json({ staleBase: true, error: { code: 'stale_session', message: 'Session changed since the client action started' } });
      return;
    }
    const type = String(req.body?.type ?? '');
    if (type === 'click') {
      await page.mouse.click(Number(req.body?.point?.x ?? 0), Number(req.body?.point?.y ?? 0));
    } else if (type === 'scroll') {
      await page.mouse.wheel(Number(req.body?.delta?.x ?? 0), Number(req.body?.delta?.y ?? 0));
    } else if (type === 'type') {
      const text = String(req.body?.text ?? '');
      if (req.body?.selector) {
        try {
          await page.locator(String(req.body.selector)).first().fill(text, { timeout: 1500 });
        } catch {
          if (req.body?.point) await page.mouse.click(Number(req.body.point.x), Number(req.body.point.y));
          await page.keyboard.type(text);
        }
      } else {
        if (req.body?.point) await page.mouse.click(Number(req.body.point.x), Number(req.body.point.y));
        await page.keyboard.type(text);
      }
    } else if (type === 'key') {
      await page.keyboard.press(String(req.body?.key ?? 'Enter'));
    } else if (type === 'reload') {
      await page.reload({ waitUntil: 'networkidle' });
    } else if (type === 'back') {
      await page.goBack({ waitUntil: 'networkidle' });
    } else if (type === 'forward') {
      await page.goForward({ waitUntil: 'networkidle' });
    } else {
      throw new MarkitHttpError(400, 'invalid_action', `Unsupported action: ${type}`);
    }
    await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined);
    await page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => page.waitForTimeout(180));
    const nextVersion = Number(session.session_version) + 1;
    context.database.db.run('UPDATE sessions SET current_url = ?, title = ?, session_version = ?, updated_at = ? WHERE id = ?', [page.url(), await page.title(), nextVersion, nowIso(), sessionId]);
    const capture = req.body?.recapture === false ? undefined : await createCapture(context, sessionId, 'viewport');
    await context.database.save();
    res.json({ staleBase: false, session: mapSession(context.repos.sessions.get(sessionId)!), capture });
  }));

  router.post('/api/sessions/:id/navigate', asyncHandler(async (req, res) => {
    const sessionId = String(req.params.id);
    const url = parseHttpUrl(String(req.body?.url ?? ''));
    const session = context.repos.sessions.get(sessionId);
    if (!session) throw new MarkitHttpError(404, 'session_not_found', 'Session not found');
    const viewport = JSON.parse(String(session.viewport_json)) as Viewport;
    const page = context.runtime.getPage(sessionId) ?? await context.runtime.createPage(sessionId, viewport);
    await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: 30_000 });
    context.database.db.run('UPDATE sessions SET current_url = ?, title = ?, session_version = session_version + 1, updated_at = ? WHERE id = ?', [page.url(), await page.title(), nowIso(), sessionId]);
    const capture = await createCapture(context, sessionId, 'viewport');
    await context.database.save();
    res.json({ session: mapSession(context.repos.sessions.get(sessionId)!), capture });
  }));


  return router;
}

async function createCapture(context: ServerContext, sessionId: string, mode: 'viewport' | 'fullPage') {
  const page = context.runtime.getPage(sessionId);
  if (!page) throw new MarkitHttpError(409, 'session_inactive', 'Session runtime page is inactive');
  const session = context.repos.sessions.get(sessionId);
  if (!session) throw new MarkitHttpError(404, 'session_not_found', 'Session not found');
  const captureId = `cap_${randomUUID()}`;
  const viewport = JSON.parse(String(session.viewport_json)) as Viewport;
  const result = await capturePage({
    page,
    dataDir: context.dataDir,
    captureId,
    mode,
    metadata: {
      id: captureId,
      sessionId,
      sessionVersion: Number(session.session_version),
      url: String(session.current_url),
      finalUrl: page.url(),
      title: await page.title(),
      viewport
    }
  });
  context.repos.captures.insert({
    id: captureId,
    sessionId,
    sessionVersion: Number(session.session_version),
    url: String(session.current_url),
    finalUrl: page.url(),
    title: await page.title(),
    viewport,
    scrollX: result.scroll.x,
    scrollY: result.scroll.y,
    mode,
    screenshotPath: result.screenshotPath,
    domTargetsPath: result.domTargetsPath,
    imageWidth: result.imageSize.width,
    imageHeight: result.imageSize.height
  });
  return mapCapture(context.repos.captures.get(captureId)!);
}

function parseViewport(value: unknown): Viewport {
  if (!value || typeof value !== 'object') return defaultViewport;
  const candidate = value as Partial<Viewport>;
  return {
    name: String(candidate.name || 'Custom'),
    width: Number(candidate.width || defaultViewport.width),
    height: Number(candidate.height || defaultViewport.height),
    deviceScaleFactor: Number(candidate.deviceScaleFactor || 1),
    isMobile: Boolean(candidate.isMobile)
  };
}
