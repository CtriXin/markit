import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Router } from 'express';
import type { Page } from 'playwright';

import type { ServerContext } from '../context.js';
import { loadCatalog, projectSnapshotFromCatalog, resolveCatalogUrl, type ProjectSnapshot } from '../catalog.js';
import { parseHttpUrl, MarkitHttpError } from '../url-safety.js';
import { capturePage } from '../runtime/capture.js';
import { asyncHandler, nowIso } from './helpers.js';
import { mapCapture, mapSession } from './mappers.js';

type Viewport = { name: string; width: number; height: number; deviceScaleFactor: number; isMobile?: boolean };
type SessionRow = NonNullable<ReturnType<ServerContext['repos']['sessions']['get']>>;

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
      runtimeStatus: 'active',
      projectSnapshot: await resolveProjectSnapshot(url.toString(), req.body?.projectSnapshot)
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
    const page = await ensureSessionPage(context, sessionId, session);
    const baseSessionVersion = Number(req.body?.baseSessionVersion ?? session.session_version);
    if (baseSessionVersion !== Number(session.session_version)) {
      res.status(409).json({ staleBase: true, error: { code: 'stale_session', message: 'Session changed since the client action started' } });
      return;
    }
    const type = String(req.body?.type ?? '');
    if (type === 'scroll' && req.body?.recapture === false) {
      const point = req.body?.point;
      const deltaX = Number(req.body?.delta?.x ?? 0);
      const deltaY = Number(req.body?.delta?.y ?? 0);
      const x = Number(point?.x ?? 0);
      const y = Number(point?.y ?? 0);
      const dispatched = await context.runtime.dispatchMouseWheel(sessionId, { x, y, deltaX, deltaY }).catch(() => false);
      if (!dispatched) {
        if (point) await page.mouse.move(x, y);
        await page.mouse.wheel(deltaX, deltaY);
      }
      res.json({ staleBase: false, session: mapSession(context.repos.sessions.get(sessionId)!), capture: undefined });
      return;
    }
    if (type === 'click') {
      await page.mouse.click(Number(req.body?.point?.x ?? 0), Number(req.body?.point?.y ?? 0));
    } else if (type === 'scroll') {
      if (req.body?.point) await page.mouse.move(Number(req.body.point.x ?? 0), Number(req.body.point.y ?? 0));
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
    if (type === 'scroll') {
      await page.waitForTimeout(90);
    } else {
      await page.waitForLoadState('domcontentloaded', { timeout: 3_000 }).catch(() => undefined);
      await page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => page.waitForTimeout(180));
    }
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
    const existingPage = context.runtime.getPage(sessionId);
    const page = existingPage && !existingPage.isClosed() ? existingPage : await context.runtime.createPage(sessionId, viewport);
    await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: 30_000 });
    context.database.db.run('UPDATE sessions SET current_url = ?, title = ?, runtime_status = ?, session_version = session_version + 1, updated_at = ? WHERE id = ?', [page.url(), await page.title(), 'active', nowIso(), sessionId]);
    const capture = await createCapture(context, sessionId, 'viewport');
    await context.database.save();
    res.json({ session: mapSession(context.repos.sessions.get(sessionId)!), capture });
  }));

  router.get('/api/sessions/:id/screencast', asyncHandler(async (req, res) => {
    const sessionId = String(req.params.id);
    const session = context.repos.sessions.get(sessionId);
    if (!session) throw new MarkitHttpError(404, 'session_not_found', 'Session not found');
    await ensureSessionPage(context, sessionId, session);
    const client = await context.runtime.createCdpSession(sessionId);
    if (!client) throw new MarkitHttpError(409, 'session_inactive', 'Session runtime page is inactive');

    let closed = false;
    const cleanup = async () => {
      if (closed) return;
      closed = true;
      await client.send('Page.stopScreencast').catch(() => undefined);
      await client.detach().catch(() => undefined);
    };

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    res.write(': connected\n\n');
    req.on('close', () => { void cleanup(); });

    client.on('Page.screencastFrame', (frame) => {
      if (closed) return;
      void client.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
      const payload = JSON.stringify({
        dataUrl: `data:image/jpeg;base64,${frame.data}`,
        timestamp: Date.now(),
        metadata: frame.metadata
      });
      res.write(`event: frame\ndata: ${payload}\n\n`);
    });

    await client.send('Page.startScreencast', { format: 'jpeg', quality: 72, everyNthFrame: 1 });
  }));


  return router;
}

async function createCapture(context: ServerContext, sessionId: string, mode: 'viewport' | 'fullPage') {
  const session = context.repos.sessions.get(sessionId);
  if (!session) throw new MarkitHttpError(404, 'session_not_found', 'Session not found');
  const page = await ensureSessionPage(context, sessionId, session);
  const captureSession = context.repos.sessions.get(sessionId)!;
  const captureId = `cap_${randomUUID()}`;
  const viewport = JSON.parse(String(captureSession.viewport_json)) as Viewport;
  const result = await capturePage({
    page,
    dataDir: context.dataDir,
    captureId,
    mode,
    metadata: {
      id: captureId,
      sessionId,
      sessionVersion: Number(captureSession.session_version),
      url: String(captureSession.current_url),
      finalUrl: page.url(),
      title: await page.title(),
      viewport
    }
  });
  context.repos.captures.insert({
    id: captureId,
    sessionId,
    sessionVersion: Number(captureSession.session_version),
    url: String(captureSession.current_url),
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

async function ensureSessionPage(context: ServerContext, sessionId: string, sessionInput?: SessionRow): Promise<Page> {
  const session = sessionInput ?? context.repos.sessions.get(sessionId);
  if (!session) throw new MarkitHttpError(404, 'session_not_found', 'Session not found');
  const existing = context.runtime.getPage(sessionId);
  if (existing && !existing.isClosed()) return existing;
  const viewport = JSON.parse(String(session.viewport_json)) as Viewport;
  const page = await context.runtime.createPage(sessionId, viewport);
  await page.goto(String(session.current_url || session.source_url), { waitUntil: 'networkidle', timeout: 30_000 });
  context.database.db.run('UPDATE sessions SET current_url = ?, title = ?, runtime_status = ?, updated_at = ? WHERE id = ?', [page.url(), await page.title(), 'active', nowIso(), sessionId]);
  return page;
}

async function resolveProjectSnapshot(url: string, provided: unknown): Promise<ProjectSnapshot | undefined> {
  const normalized = normalizeProjectSnapshot(provided);
  if (normalized) return normalized;
  const catalog = await loadCatalog();
  const resolved = resolveCatalogUrl(catalog, url);
  if (!resolved.matched || !resolved.project) return undefined;
  const input: Parameters<typeof projectSnapshotFromCatalog>[0] = {
    status: resolved.status,
    project: resolved.project,
    source: 'catalog-resolve'
  };
  if (resolved.domain) input.domain = resolved.domain;
  if (resolved.matchedHost) input.matchedHost = resolved.matchedHost;
  return projectSnapshotFromCatalog(input);
}

function normalizeProjectSnapshot(value: unknown): ProjectSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<ProjectSnapshot>;
  const project = input.project;
  if (!project?.id || !project.name) return undefined;
  const snapshot: ProjectSnapshot = {
    schema: 'markit.project-snapshot.v1',
    source: input.source === 'client' ? 'client' : 'catalog-resolve',
    capturedAt: typeof input.capturedAt === 'string' ? input.capturedAt : new Date().toISOString(),
    project: {
      id: String(project.id),
      name: String(project.name),
      status: String(project.status || 'unknown')
    }
  };
  if (typeof input.catalogRoot === 'string') snapshot.catalogRoot = input.catalogRoot;
  if (typeof input.catalogGeneratedAt === 'string') snapshot.catalogGeneratedAt = input.catalogGeneratedAt;
  if (project.scmpService) snapshot.project.scmpService = String(project.scmpService);
  if (project.gitlabPath) snapshot.project.gitlabPath = String(project.gitlabPath);
  if (project.activeBranch) snapshot.project.activeBranch = String(project.activeBranch);
  if (project.issueProjectPath) snapshot.project.issueProjectPath = String(project.issueProjectPath);
  if (project.defaultAssignee) snapshot.project.defaultAssignee = String(project.defaultAssignee);
  if (Array.isArray(project.defaultAssignees)) snapshot.project.defaultAssignees = project.defaultAssignees.map(String).filter(Boolean);
  if (Array.isArray(project.labels)) snapshot.project.labels = project.labels.map(String);
  if (typeof project.confidence === 'number') snapshot.project.confidence = project.confidence;
  if (input.domain?.host) {
    snapshot.domain = {
      host: String(input.domain.host),
      url: String(input.domain.url || `https://${input.domain.host}`),
      env: String(input.domain.env || 'unknown'),
      status: String(input.domain.status || 'unknown')
    };
    if (input.domain.activeBranch) snapshot.domain.activeBranch = String(input.domain.activeBranch);
    if (input.domain.matchedHost) snapshot.domain.matchedHost = String(input.domain.matchedHost);
    if (input.domain.defaultAssignee) snapshot.domain.defaultAssignee = String(input.domain.defaultAssignee);
    if (Array.isArray(input.domain.defaultAssignees)) snapshot.domain.defaultAssignees = input.domain.defaultAssignees.map(String).filter(Boolean);
  }
  return snapshot;
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
