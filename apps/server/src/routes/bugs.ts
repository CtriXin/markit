import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { PNG } from 'pngjs';
import { Router } from 'express';
import type { ServerContext } from '../context.js';
import { MarkitHttpError } from '../url-safety.js';
import { all, asyncHandler, first, nowIso, parseJson, type Row } from './helpers.js';
import { mapAnnotation, mapBug, mapBugAsset, mapCapture } from './mappers.js';

const maxAssetBytes = 8 * 1024 * 1024;
const allowedAssetTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const DEFAULT_ISSUE_HUB_PROJECT_PATH = 'ptc/fe/ptc-wiki';
const DEFAULT_GITLAB_BASE_URL = 'https://gitlab.adsconflux.xyz';
const gitLabUploadLimit = 20;
const issueSubmitLocks = new Map<string, Promise<unknown>>();

type IssueProjectSnapshot = {
  project?: {
    id?: string;
    name?: string;
    status?: string;
    issueProjectPath?: string;
    gitlabPath?: string;
    activeBranch?: string;
    defaultAssignee?: string;
    defaultAssignees?: string[];
    labels?: string[];
  };
  domain?: {
    host?: string;
    url?: string;
    env?: string;
    status?: string;
    activeBranch?: string;
    defaultAssignee?: string;
    defaultAssignees?: string[];
  };
};

type IssuePayload = ReturnType<typeof issuePayloadFromDetail>;

type IssueSubmitOptions = {
  assignees: string[];
};

type GitLabConfig = {
  baseUrl: string;
  hostname: string;
  auth: { kind: 'token'; token: string } | { kind: 'glab' };
};

type GitLabIssueResult = {
  bugId: string;
  title: string;
  projectPath: string;
  iid: number;
  id: number;
  webUrl: string;
  workItemUrl: string;
  assignee: string;
  assignees: string[];
  assigneeIds?: number[];
  unresolvedAssignees?: string[];
  assigneeResolved: boolean;
  labels: string[];
  uploadedEvidence: GitLabUploadResult[];
  remoteEvidenceCount?: number;
  reused?: boolean;
  synced?: boolean;
};

type GitLabCurrentUser = {
  id: number;
  username: string;
  name?: string;
};

type GitLabUploadResult = {
  filePath: string;
  markdown: string;
  url?: string;
  fullPath?: string;
  assetUrl?: string;
};

type IssueAssigneePlan = {
  requestedAssignees: string[];
  assignees: string[];
  assigneeIds: number[];
  unresolvedAssignees: string[];
};

type DirectoryEntry = {
  name: string;
  isDirectory(): boolean;
};

export function bugsRouter(context: ServerContext): Router {
  const router = Router();

  router.get('/api/bugs', asyncHandler(async (req, res) => {
    const status = req.query.status ? String(req.query.status) : undefined;
    const rows = status && status !== 'all'
      ? all(context.database.db, 'SELECT * FROM bugs WHERE status = ? ORDER BY created_at DESC', [status])
      : all(context.database.db, 'SELECT * FROM bugs ORDER BY created_at DESC');
    const submissions = await existingSubmissionsForBugs(context, rows.map((row) => String(row.id)));
    res.json({ bugs: rows.map((row) => bugSummaryFromRow(context, row, submissions.get(String(row.id)))) });
  }));

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

  router.post('/api/bugs/bulk-export', asyncHandler(async (req, res) => {
    const bugIds = bugIdsFromBody(req.body);
    const exports = await exportBugs(context, bugIds);
    await context.database.save();
    res.json({ count: exports.length, exports });
  }));

  router.post('/api/bugs/issue-draft', asyncHandler(async (req, res) => {
    const { bugIds, options } = issueRequestFromBody(req.body);
    const draft = await writeIssueDraft(context, bugIds, options);
    await context.database.save();
    res.json(draft);
  }));

  router.post('/api/bugs/issue-submit', asyncHandler(async (req, res) => {
    const { bugIds, options } = issueRequestFromBody(req.body);
    const result = await submitIssueDraft(context, bugIds, options);
    await context.database.save();
    res.json(result);
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

function bugIdsFromBody(body: unknown): string[] {
  const input = body && typeof body === 'object' ? body as { bugIds?: unknown } : {};
  if (!Array.isArray(input.bugIds)) throw new MarkitHttpError(400, 'bug_ids_required', 'Missing bugIds array');
  const bugIds = [...new Set(input.bugIds.map((id) => String(id).trim()).filter(Boolean))];
  if (!bugIds.length) throw new MarkitHttpError(400, 'bug_ids_required', 'Select at least one bug');
  if (bugIds.length > 100) throw new MarkitHttpError(400, 'too_many_bugs', 'Bulk actions support at most 100 bugs');
  return bugIds;
}

function issueRequestFromBody(body: unknown): { bugIds: string[]; options: IssueSubmitOptions } {
  return {
    bugIds: bugIdsFromBody(body),
    options: issueSubmitOptionsFromBody(body)
  };
}

function issueSubmitOptionsFromBody(body: unknown): IssueSubmitOptions {
  const input = body && typeof body === 'object' ? body as { assignee?: unknown; assignees?: unknown } : {};
  return { assignees: normalizeAssignees(input.assignees ?? input.assignee) };
}

function normalizeAssignees(value: unknown): string[] {
  const rawItems = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const names = rawItems.flatMap((item) => String(item).split(/[,，、;；\n]+/))
    .map((item) => item.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

function formatAssignees(assignees: string[]): string {
  return assignees.join(', ');
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

function bugSummaryFromRow(context: ServerContext, row: Row, issueSubmission?: GitLabIssueResult) {
  const bugId = String(row.id);
  return {
    ...mapBug(row),
    projectSnapshot: projectSnapshotForBug(context, row),
    annotationCount: countRelations(context, bugId),
    assetCount: countAssets(context, bugId),
    issueSubmission
  };
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
  const projectSnapshot = projectSnapshotForBug(context, bug);
  const issueSubmission = (await existingSubmissionsForBugs(context, [id])).get(id);
  return { bug: { ...mapBug(bug), projectSnapshot, annotationCount: annotations.length, assetCount: assets.length, issueSubmission }, annotations, captures, assets, projectSnapshot };
}

function projectSnapshotForBug(context: ServerContext, bug: Row) {
  const session = first(context.database.db, 'SELECT project_snapshot_json FROM sessions WHERE id = ?', [String(bug.session_id)]);
  return session ? parseJson(session.project_snapshot_json, undefined) : undefined;
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

function mimeTypeForFile(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'image/png';
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
  const captureIds = new Set(groups.keys());
  if (detail.bug.primaryCaptureId) captureIds.add(detail.bug.primaryCaptureId);
  for (const captureId of captureIds) {
    const annotations = groups.get(captureId) ?? [];
    const capture = first(context.database.db, 'SELECT * FROM captures WHERE id = ?', [captureId]);
    if (!capture) continue;
    const captureDir = join(exportDir, 'captures', captureId);
    const cropDir = join(captureDir, 'crops');
    await mkdir(cropDir, { recursive: true });
    if (annotations.length) {
      const png = PNG.sync.read(await readFile(String(capture.screenshot_path)));
      for (const annotation of annotations) {
        drawAnnotation(png, annotation);
        await writeCrop(png, annotation, join(cropDir, `${annotation.id}.png`));
      }
      await writeFile(join(captureDir, 'screenshot.annotated.png'), PNG.sync.write(png));
    } else {
      await copyFile(String(capture.screenshot_path), join(captureDir, 'screenshot.png'));
    }
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

async function exportBugs(context: ServerContext, bugIds: string[]) {
  const results = [];
  for (const bugId of bugIds) {
    const result = await exportBug(context, bugId);
    results.push({ bugId, exportPath: result.exportPath });
  }
  return results;
}

async function writeIssueDraft(context: ServerContext, bugIds: string[], options: IssueSubmitOptions = { assignees: [] }) {
  const exported = await Promise.all(bugIds.map(async (bugId) => {
    const result = await exportBug(context, bugId);
    const detail = await bugDetail(context, bugId);
    return { result, detail };
  }));
  const issues = exported
    .map(({ result, detail }) => issuePayloadFromDetail(detail, result.markdown, options))
    .sort(compareIssuePayloads);
  const stamp = nowIso().replace(/[:.]/g, '-');
  const draftDir = join(context.dataDir, 'issue-drafts', stamp);
  await mkdir(draftDir, { recursive: true });
  const payload = {
    schema: 'markit.gitlab-issue-draft.v1',
    mode: 'dry-run',
    createdAt: nowIso(),
    count: issues.length,
    issues
  };
  const jsonPath = join(draftDir, 'issues.json');
  const markdownPath = join(draftDir, 'issues.md');
  await writeFile(jsonPath, JSON.stringify(payload, null, 2));
  await writeFile(markdownPath, renderIssueDraftMarkdown(issues));
  return { mode: 'dry-run', count: issues.length, draftDir, jsonPath, markdownPath, issues };
}

async function submitIssueDraft(context: ServerContext, bugIds: string[], options: IssueSubmitOptions = { assignees: [] }) {
  const blocking = bugIds.map((bugId) => issueSubmitLocks.get(bugId)).filter((promise): promise is Promise<unknown> => Boolean(promise));
  if (blocking.length) {
    await Promise.allSettled(blocking);
    return submitIssueDraft(context, bugIds, options);
  }
  const promise = submitIssueDraftUnlocked(context, bugIds, options);
  for (const bugId of bugIds) issueSubmitLocks.set(bugId, promise);
  try {
    return await promise;
  } finally {
    for (const bugId of bugIds) {
      if (issueSubmitLocks.get(bugId) === promise) issueSubmitLocks.delete(bugId);
    }
  }
}

async function submitIssueDraftUnlocked(context: ServerContext, bugIds: string[], options: IssueSubmitOptions) {
  const existing = await existingSubmissionsForBugs(context, bugIds);
  if (!options.assignees.length && bugIds.every((bugId) => existing.has(bugId))) return await writeExistingIssueSubmit(context, bugIds, existing);
  const config = gitLabConfigFromEnv(process.env);
  const pendingBugIds = bugIds.filter((bugId) => !existing.has(bugId));
  const draft = await writeIssueDraft(context, bugIds, options);
  const issuesToSubmit = draft.issues.filter((issue) => pendingBugIds.includes(issue.bugId));
  const issuesToSync = draft.issues.filter((issue) => existing.has(issue.bugId));
  const createdSubmissions = await submitGitLabIssues(issuesToSubmit, config);
  const reusedSubmissions = await syncExistingGitLabIssues(issuesToSync, existing, config);
  const submissions = [...reusedSubmissions, ...createdSubmissions];
  const submittedAt = nowIso();
  const submitPath = join(draft.draftDir, 'submitted.json');
  const result = {
    ...draft,
    mode: 'submit',
    submittedAt,
    createdCount: createdSubmissions.length,
    skippedCount: reusedSubmissions.length,
    syncedCount: reusedSubmissions.filter((submission) => submission.synced).length,
    target: {
      baseUrl: config.baseUrl,
      projectPath: DEFAULT_ISSUE_HUB_PROJECT_PATH
    },
    submissions
  };
  await writeFile(submitPath, JSON.stringify({ schema: 'markit.gitlab-issue-submit.v1', ...result }, null, 2));
  return { ...result, submitPath };
}

async function writeExistingIssueSubmit(context: ServerContext, bugIds: string[], existing: Map<string, GitLabIssueResult>) {
  const submissions = bugIds.map((bugId) => existing.get(bugId)).filter((submission): submission is GitLabIssueResult => Boolean(submission)).map((submission) => ({ ...submission, reused: true }));
  const submittedAt = nowIso();
  const stamp = submittedAt.replace(/[:.]/g, '-');
  const draftDir = join(context.dataDir, 'issue-drafts', stamp);
  await mkdir(draftDir, { recursive: true });
  const submitPath = join(draftDir, 'submitted.json');
  const markdownPath = join(draftDir, 'issues.md');
  const jsonPath = join(draftDir, 'issues.json');
  const result = {
    mode: 'submit',
    duplicate: true,
    createdAt: submittedAt,
    submittedAt,
    count: submissions.length,
    createdCount: 0,
    skippedCount: submissions.length,
    syncedCount: 0,
    draftDir,
    jsonPath,
    markdownPath,
    issues: [],
    target: {
      baseUrl: DEFAULT_GITLAB_BASE_URL,
      projectPath: DEFAULT_ISSUE_HUB_PROJECT_PATH
    },
    submissions
  };
  await writeFile(jsonPath, JSON.stringify({ schema: 'markit.gitlab-issue-draft.v1', ...result }, null, 2));
  await writeFile(markdownPath, renderExistingSubmitMarkdown(submissions));
  await writeFile(submitPath, JSON.stringify({ schema: 'markit.gitlab-issue-submit.v1', ...result }, null, 2));
  return { ...result, submitPath };
}

function renderExistingSubmitMarkdown(submissions: GitLabIssueResult[]): string {
  return `# GitLab Issue Submit\n\nDuplicate submit was skipped locally; existing Work Items were returned.\n\n${submissions.map((submission) => `- ${submission.title}: ${submission.workItemUrl || submission.webUrl}`).join('\n')}\n`;
}

async function syncExistingGitLabIssues(issues: IssuePayload[], existing: Map<string, GitLabIssueResult>, config: GitLabConfig): Promise<GitLabIssueResult[]> {
  const results: GitLabIssueResult[] = [];
  const assigneeCache = new Map<string, number | undefined>();
  let currentUser: GitLabCurrentUser | undefined;
  for (const issue of issues) {
    const previous = existing.get(issue.bugId);
    if (!previous) continue;
    const current = await gitLabRequest<{ id: number; iid: number; web_url?: string; description?: string }>(
      config,
      `/api/v4/projects/${encodeURIComponent(previous.projectPath || issue.projectPath)}/issues/${previous.iid}`,
      { method: 'GET', tolerateNotFound: true }
    );
    const currentDescription = current?.description ?? '';
    const projectPath = previous.projectPath || issue.projectPath;
    const normalizedDescription = normalizeGitLabUploadLinks(currentDescription, config.baseUrl, projectPath);
    const assigneePlan = issue.assigneeSource === 'manual'
      ? await resolveIssueAssigneePlan(config, issue, assigneeCache, async () => (currentUser ??= await resolveCurrentGitLabUser(config)))
      : undefined;
    let description = normalizedDescription;
    let uploadedEvidence: GitLabUploadResult[] = [];
    if (!descriptionHasDurableScreenshotEvidence(normalizedDescription)) {
      uploadedEvidence = await uploadIssueEvidence(config, issue);
      if (uploadedEvidence.length) description = withUploadedEvidence(currentDescription || issue.description, uploadedEvidence);
    }
    if (assigneePlan) description = withAssigneeResolutionWarning(description, assigneePlan);
    const body: Record<string, unknown> = {};
    if (description !== currentDescription) body.description = description;
    if (assigneePlan?.assigneeIds.length) body.assignee_ids = assigneePlan.assigneeIds;
    const updated = Object.keys(body).length
      ? await gitLabRequest<{ id: number; iid: number; web_url?: string }>(
        config,
        `/api/v4/projects/${encodeURIComponent(projectPath)}/issues/${previous.iid}`,
        { method: 'PUT', body }
      )
      : undefined;
    const result: GitLabIssueResult = {
      ...previous,
      id: updated?.id ?? current?.id ?? previous.id,
      iid: updated?.iid ?? current?.iid ?? previous.iid,
      webUrl: updated?.web_url ?? current?.web_url ?? previous.webUrl,
      workItemUrl: `${config.baseUrl}/${projectPath}/-/work_items/${updated?.iid ?? current?.iid ?? previous.iid}`,
      uploadedEvidence: uploadedEvidence.length ? uploadedEvidence : previous.uploadedEvidence ?? [],
      remoteEvidenceCount: (uploadedEvidence.length ? uploadedEvidence.length : previous.uploadedEvidence?.length) || screenshotEvidenceCount(description),
      reused: true,
      synced: Boolean(Object.keys(body).length)
    };
    if (assigneePlan) applyAssigneePlanToExistingResult(result, assigneePlan);
    results.push(result);
  }
  return results;
}

function descriptionHasDurableScreenshotEvidence(description: string): boolean {
  return /##\s*Screenshots/i.test(description) && /(?:\/-\/project\/|https?:\/\/[^\s)]+\.(?:png|jpe?g|webp))/i.test(description);
}

function screenshotEvidenceCount(description: string): number {
  return (description.match(/!\[[^\]]*]\([^)]+\.(?:png|jpe?g|webp)[^)]*\)/gi) ?? []).length;
}

function normalizeGitLabUploadLinks(description: string, baseUrl: string, projectPath: string): string {
  if (!description) return description;
  return description.replace(/\]\(\/uploads\//g, `](${baseUrl}/${projectPath}/uploads/`);
}

async function existingSubmissionsForBugs(context: ServerContext, bugIds: string[]): Promise<Map<string, GitLabIssueResult>> {
  const wanted = new Set(bugIds);
  const submissions = new Map<string, GitLabIssueResult>();
  const draftsDir = join(context.dataDir, 'issue-drafts');
  let entries: DirectoryEntry[];
  try {
    entries = await readdir(draftsDir, { withFileTypes: true });
  } catch {
    return submissions;
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  for (const dir of dirs) {
    const path = join(draftsDir, dir, 'submitted.json');
    try {
      const payload = parseJson<{ submissions?: Array<Partial<GitLabIssueResult>> }>(await readFile(path, 'utf8'), {});
      for (const submission of payload.submissions ?? []) {
        const normalized = normalizeGitLabIssueResult(submission);
        if (wanted.has(normalized.bugId)) submissions.set(normalized.bugId, normalized);
      }
    } catch {
      // Ignore partial or legacy draft folders.
    }
  }
  return submissions;
}

function normalizeGitLabIssueResult(submission: Partial<GitLabIssueResult>): GitLabIssueResult {
  const assignees = normalizeAssignees(submission.assignees ?? submission.assignee);
  const unresolvedAssignees = normalizeAssignees(submission.unresolvedAssignees);
  const assigneeIds = Array.isArray(submission.assigneeIds)
    ? submission.assigneeIds.map((id) => Number(id)).filter((id) => Number.isFinite(id))
    : undefined;
  const normalized: GitLabIssueResult = {
    ...(submission as GitLabIssueResult),
    bugId: String(submission.bugId ?? ''),
    title: String(submission.title ?? ''),
    projectPath: String(submission.projectPath ?? DEFAULT_ISSUE_HUB_PROJECT_PATH),
    iid: Number(submission.iid ?? 0),
    id: Number(submission.id ?? 0),
    webUrl: String(submission.webUrl ?? ''),
    workItemUrl: String(submission.workItemUrl ?? submission.webUrl ?? ''),
    assignee: formatAssignees(assignees) || String(submission.assignee ?? ''),
    assignees,
    assigneeResolved: Boolean(submission.assigneeResolved),
    labels: submission.labels ?? [],
    uploadedEvidence: submission.uploadedEvidence ?? []
  };
  if (assigneeIds?.length) normalized.assigneeIds = assigneeIds;
  if (unresolvedAssignees.length) normalized.unresolvedAssignees = unresolvedAssignees;
  return normalized;
}

function gitLabConfigFromEnv(env: NodeJS.ProcessEnv): GitLabConfig {
  const baseUrl = String(env.MARKIT_GITLAB_BASE_URL || DEFAULT_GITLAB_BASE_URL).replace(/\/+$/, '');
  const hostname = safeHostname(baseUrl);
  const authMode = String(env.MARKIT_GITLAB_AUTH || 'auto').toLowerCase();
  const token = firstNonEmpty(env.MARKIT_GITLAB_TOKEN, env.GITLAB_TOKEN, env.GLAB_TOKEN);
  if (token && authMode !== 'glab') return { baseUrl, hostname, auth: { kind: 'token', token } };
  if (authMode === 'token') {
    throw new MarkitHttpError(424, 'gitlab_auth_missing', 'Missing GitLab token. Set MARKIT_GITLAB_TOKEN, or use MARKIT_GITLAB_AUTH=auto with glab auth login.');
  }
  return { baseUrl, hostname, auth: { kind: 'glab' } };
}

async function submitGitLabIssues(issues: IssuePayload[], config: GitLabConfig): Promise<GitLabIssueResult[]> {
  const assigneeCache = new Map<string, number | undefined>();
  let currentUser: GitLabCurrentUser | undefined;
  const results: GitLabIssueResult[] = [];
  for (const issue of issues) {
    const assigneePlan = await resolveIssueAssigneePlan(config, issue, assigneeCache, async () => (currentUser ??= await resolveCurrentGitLabUser(config)));
    const configuredAssignees = issue.assignees.length ? issue.assignees : normalizeAssignees(issue.assignee);
    const uploadedEvidence = await uploadIssueEvidence(config, issue);
    const description = withUploadedEvidence(
      withAssigneeResolutionWarning(withResolvedAssignee(issue.description, configuredAssignees, assigneePlan.assignees), assigneePlan),
      uploadedEvidence
    );
    const body: Record<string, unknown> = {
      title: issue.title,
      description,
      labels: issue.labels.join(',')
    };
    if (assigneePlan.assigneeIds.length) body.assignee_ids = assigneePlan.assigneeIds;
    const created = await gitLabRequest<{ id: number; iid: number; web_url?: string }>(
      config,
      `/api/v4/projects/${encodeURIComponent(issue.projectPath)}/issues`,
      { method: 'POST', body }
    );
    const webUrl = created.web_url ?? `${config.baseUrl}/${issue.projectPath}/-/issues/${created.iid}`;
    const result: GitLabIssueResult = {
      bugId: issue.bugId,
      title: issue.title,
      projectPath: issue.projectPath,
      iid: created.iid,
      id: created.id,
      webUrl,
      workItemUrl: `${config.baseUrl}/${issue.projectPath}/-/work_items/${created.iid}`,
      assignee: '',
      assignees: [],
      assigneeResolved: false,
      labels: issue.labels,
      uploadedEvidence
    };
    applyAssigneePlanToResult(result, assigneePlan);
    results.push(result);
  }
  return results;
}

async function resolveCurrentGitLabUser(config: GitLabConfig): Promise<GitLabCurrentUser | undefined> {
  return await gitLabRequest<GitLabCurrentUser>(config, '/api/v4/user', { method: 'GET' });
}

async function uploadIssueEvidence(config: GitLabConfig, issue: IssuePayload): Promise<GitLabUploadResult[]> {
  const files = await evidenceFilesForIssue(issue.exportPath);
  const uploaded: GitLabUploadResult[] = [];
  for (const filePath of files) {
    uploaded.push(await gitLabUpload(config, issue.projectPath, filePath));
  }
  return uploaded;
}

async function evidenceFilesForIssue(exportPath: string): Promise<string[]> {
  if (!exportPath) return [];
  const files: string[] = [];
  await collectEvidenceFiles(exportPath, files);
  const preferred = files.sort((a, b) => evidenceFileRank(a) - evidenceFileRank(b) || a.localeCompare(b));
  return preferred.slice(0, gitLabUploadLimit);
}

async function collectEvidenceFiles(dir: string, files: string[]): Promise<void> {
  let entries: DirectoryEntry[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectEvidenceFiles(path, files);
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) files.push(path);
  }
}

function evidenceFileRank(path: string): number {
  if (path.includes('screenshot.annotated')) return 0;
  if (path.endsWith('screenshot.png')) return 1;
  if (path.includes('/crops/')) return 2;
  if (path.includes('/assets/')) return 3;
  return 4;
}

function withUploadedEvidence(description: string, uploaded: GitLabUploadResult[]): string {
  if (!uploaded.length) return description;
  const screenshots = uploaded.map((item) => {
    const fileName = basename(item.filePath);
    const link = item.assetUrl ?? item.fullPath ?? item.url;
    const linkedName = link ? `[${fileName}](${link})` : fileName;
    return `- ${linkedName}\n\n${item.markdown}`;
  }).join('\n\n');
  return `${description}\n\n## Screenshots\n\n${screenshots}\n`;
}

function withResolvedAssignee(description: string, configuredAssignees: string[], assignees: string[]): string {
  if (configuredAssignees.length || !assignees.length) return description;
  return description.replace('- Assignee Suggestion: not configured', `- Assignee Suggestion: ${formatAssignees(assignees)} (default current GitLab user)`);
}

function withAssigneeResolutionWarning(description: string, plan: IssueAssigneePlan): string {
  const cleaned = removeAssigneeResolutionWarning(description);
  if (!plan.unresolvedAssignees.length) return cleaned;
  const applied = plan.assignees.length ? formatAssignees(plan.assignees) : 'unchanged';
  return `${cleaned}\n\n## Markit Assignment Warning\n\n- Applied Assignees: ${applied}\n- Unresolved Assignees: ${formatAssignees(plan.unresolvedAssignees)}\n`;
}

function removeAssigneeResolutionWarning(description: string): string {
  return description.replace(/\n*## Markit Assignment Warning\n\n- Applied Assignees:.*(?:\n- Unresolved Assignees:.*)?(?:\n|$)/g, '').trimEnd();
}

async function resolveIssueAssigneePlan(
  config: GitLabConfig,
  issue: IssuePayload,
  cache: Map<string, number | undefined>,
  currentUser: () => Promise<GitLabCurrentUser | undefined>
): Promise<IssueAssigneePlan> {
  const requestedAssignees = issue.assignees.length ? issue.assignees : normalizeAssignees(issue.assignee);
  if (!requestedAssignees.length) {
    const user = await currentUser();
    return {
      requestedAssignees: user?.username ? [user.username] : [],
      assignees: user?.username ? [user.username] : [],
      assigneeIds: user?.id ? [user.id] : [],
      unresolvedAssignees: []
    };
  }
  const assignees: string[] = [];
  const assigneeIds: number[] = [];
  const unresolvedAssignees: string[] = [];
  for (const username of requestedAssignees) {
    const userId = await resolveGitLabUserId(config, username, cache);
    if (userId) {
      assignees.push(username);
      if (!assigneeIds.includes(userId)) assigneeIds.push(userId);
    } else {
      unresolvedAssignees.push(username);
    }
  }
  return { requestedAssignees, assignees, assigneeIds, unresolvedAssignees };
}

function applyAssigneePlanToResult(result: GitLabIssueResult, plan: IssueAssigneePlan) {
  result.assignee = formatAssignees(plan.assignees);
  result.assignees = plan.assignees;
  result.assigneeResolved = Boolean(plan.requestedAssignees.length) && plan.unresolvedAssignees.length === 0 && plan.assigneeIds.length === plan.requestedAssignees.length;
  if (plan.assigneeIds.length) result.assigneeIds = plan.assigneeIds;
  else delete result.assigneeIds;
  if (plan.unresolvedAssignees.length) result.unresolvedAssignees = plan.unresolvedAssignees;
  else delete result.unresolvedAssignees;
}

function applyAssigneePlanToExistingResult(result: GitLabIssueResult, plan: IssueAssigneePlan) {
  if (plan.assigneeIds.length) {
    applyAssigneePlanToResult(result, plan);
    return;
  }
  result.assigneeResolved = false;
  if (plan.unresolvedAssignees.length) result.unresolvedAssignees = plan.unresolvedAssignees;
  else delete result.unresolvedAssignees;
}

async function resolveGitLabUserId(config: GitLabConfig, username: string, cache: Map<string, number | undefined>): Promise<number | undefined> {
  const key = username.trim();
  if (!key) return undefined;
  if (cache.has(key)) return cache.get(key);
  const users = await gitLabRequest<Array<{ id: number; username: string }>>(
    config,
    `/api/v4/users?username=${encodeURIComponent(key)}`,
    { method: 'GET', tolerateNotFound: true }
  );
  const userId = Array.isArray(users) ? users.find((user) => user.username === key)?.id : undefined;
  cache.set(key, userId);
  return userId;
}

async function gitLabRequest<T>(config: GitLabConfig, path: string, options: { method: 'GET' | 'POST' | 'PUT'; body?: Record<string, unknown>; tolerateNotFound?: boolean }): Promise<T> {
  if (config.auth.kind === 'glab') return await gitLabGlabRequest<T>(config, path, options);
  const init: RequestInit = {
    method: options.method,
    headers: {
      'content-type': 'application/json',
      'private-token': config.auth.token
    }
  };
  if (options.body) init.body = JSON.stringify(options.body);
  const response = await fetch(`${config.baseUrl}${path}`, init);
  if (options.tolerateNotFound && response.status === 404) return [] as T;
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const message = detail ? `GitLab API failed: ${response.status} ${detail.slice(0, 240)}` : `GitLab API failed: ${response.status} ${response.statusText}`;
    throw new MarkitHttpError(response.status === 401 || response.status === 403 ? 424 : 502, 'gitlab_submit_failed', message);
  }
  return await response.json() as T;
}

async function gitLabUpload(config: GitLabConfig, projectPath: string, filePath: string): Promise<GitLabUploadResult> {
  if (config.auth.kind === 'glab') return await gitLabGlabUpload(config, projectPath, filePath);
  const form = new FormData();
  const file = await readFile(filePath);
  form.append('file', new Blob([file], { type: mimeTypeForFile(filePath) }), basename(filePath));
  const response = await fetch(`${config.baseUrl}/api/v4/projects/${encodeURIComponent(projectPath)}/uploads`, {
    method: 'POST',
    headers: { 'private-token': config.auth.token },
    body: form
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new MarkitHttpError(502, 'gitlab_upload_failed', detail ? `GitLab upload failed: ${response.status} ${detail.slice(0, 240)}` : `GitLab upload failed: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json() as { markdown?: string; url?: string; full_path?: string };
  if (!payload.markdown) throw new MarkitHttpError(502, 'gitlab_upload_failed', 'GitLab upload response did not include markdown.');
  return uploadResultFromPayload(config, projectPath, filePath, payload);
}

function gitLabGlabUpload(config: GitLabConfig, projectPath: string, filePath: string): Promise<GitLabUploadResult> {
  return new Promise((resolve, reject) => {
    const endpoint = `projects/${encodeURIComponent(projectPath)}/uploads`;
    const args = ['api', '--hostname', config.hostname, '--method', 'POST', endpoint, '--output', 'json', '--form', `file=@${filePath}`];
    const child = spawn('glab', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new MarkitHttpError(504, 'gitlab_upload_failed', 'glab api timed out while uploading GitLab evidence.'));
    }, 60_000);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(new MarkitHttpError(424, 'gitlab_auth_missing', 'glab CLI not found. Install glab or set MARKIT_GITLAB_TOKEN.'));
        return;
      }
      reject(new MarkitHttpError(502, 'gitlab_upload_failed', `glab upload failed: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(glabErrorMessage(config.hostname, errorOutput || output, 'gitlab_upload_failed'));
        return;
      }
      try {
        const payload = output ? JSON.parse(output) as { markdown?: string; url?: string; full_path?: string } : {};
        if (!payload.markdown) {
          reject(new MarkitHttpError(502, 'gitlab_upload_failed', 'glab upload response did not include markdown.'));
          return;
        }
        resolve(uploadResultFromPayload(config, projectPath, filePath, payload));
      } catch (error) {
        reject(new MarkitHttpError(502, 'gitlab_upload_failed', `glab upload returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

function uploadResultFromPayload(config: GitLabConfig, projectPath: string, filePath: string, payload: { markdown?: string; url?: string; full_path?: string }): GitLabUploadResult {
  if (!payload.markdown) throw new MarkitHttpError(502, 'gitlab_upload_failed', 'GitLab upload response did not include markdown.');
  const assetUrl = absoluteGitLabAssetUrl(config.baseUrl, projectPath, payload.full_path || payload.url || markdownUrlFromUpload(payload.markdown));
  const alt = basename(filePath, extname(filePath));
  return {
    filePath,
    markdown: assetUrl ? `![${alt}](${assetUrl})` : payload.markdown,
    ...(payload.url ? { url: payload.url } : {}),
    ...(payload.full_path ? { fullPath: payload.full_path } : {}),
    ...(assetUrl ? { assetUrl } : {})
  };
}

function markdownUrlFromUpload(markdown: string): string {
  const match = markdown.match(/\]\(([^)]+)\)/);
  return match?.[1] ?? '';
}

function absoluteGitLabAssetUrl(baseUrl: string, projectPath: string, path: string): string {
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith('/uploads/')) return `${baseUrl}/${projectPath}${path}`;
  return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
}

function gitLabGlabRequest<T>(config: GitLabConfig, path: string, options: { method: 'GET' | 'POST' | 'PUT'; body?: Record<string, unknown>; tolerateNotFound?: boolean }): Promise<T> {
  return new Promise((resolve, reject) => {
    const endpoint = path.replace(/^\/api\/v4\/?/, '');
    const args = ['api', '--hostname', config.hostname, '--method', options.method, endpoint, '--output', 'json'];
    if (options.body) args.push('--header', 'Content-Type: application/json', '--input', '-');
    const child = spawn('glab', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new MarkitHttpError(504, 'gitlab_submit_failed', 'glab api timed out while submitting GitLab Issue.'));
    }, 60_000);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(new MarkitHttpError(424, 'gitlab_auth_missing', 'glab CLI not found. Install glab or set MARKIT_GITLAB_TOKEN.'));
        return;
      }
      reject(new MarkitHttpError(502, 'gitlab_submit_failed', `glab api failed: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        const message = glabErrorMessage(config.hostname, errorOutput || output);
        reject(message);
        return;
      }
      try {
        resolve(output ? JSON.parse(output) as T : {} as T);
      } catch (error) {
        reject(new MarkitHttpError(502, 'gitlab_submit_failed', `glab api returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    if (options.body) child.stdin.end(JSON.stringify(options.body));
    else child.stdin.end();
  });
}

function glabErrorMessage(hostname: string, output: string, code = 'gitlab_submit_failed'): MarkitHttpError {
  const normalized = output.toLowerCase();
  if (normalized.includes('not been authenticated') || normalized.includes('not authenticated') || normalized.includes('auth login')) {
    return new MarkitHttpError(424, 'gitlab_auth_missing', `glab is not authenticated for ${hostname}. Run: glab auth login --hostname ${hostname}`);
  }
  return new MarkitHttpError(502, code, `glab api failed: ${output.trim().slice(0, 240) || 'unknown error'}`);
}

function issuePayloadFromDetail(detail: Awaited<ReturnType<typeof bugDetail>>, markdown: string, options: IssueSubmitOptions = { assignees: [] }) {
  const bug = detail.bug;
  const snapshot = detail.projectSnapshot as IssueProjectSnapshot | undefined;
  const project = snapshot?.project;
  const domain = snapshot?.domain?.host ?? safeHost(bug.finalUrl);
  const branch = project?.activeBranch ?? snapshot?.domain?.activeBranch ?? '';
  const businessProjectPath = project?.issueProjectPath ?? project?.gitlabPath ?? '';
  const sourceProjectPath = project?.gitlabPath ?? project?.issueProjectPath ?? '';
  const bindingStatus = project ? 'bound' : 'unbound';
  const labels = [...new Set([...(project?.labels ?? ['markit', 'bug']), bindingStatus === 'unbound' ? 'unbound-project' : '', bug.severity, domain].filter(Boolean))];
  const domainAssignees = snapshot?.domain?.defaultAssignees?.length ? normalizeAssignees(snapshot.domain.defaultAssignees) : normalizeAssignees(snapshot?.domain?.defaultAssignee);
  const projectAssignees = project?.defaultAssignees?.length ? normalizeAssignees(project.defaultAssignees) : normalizeAssignees(project?.defaultAssignee);
  const catalogAssignees = domainAssignees.length ? domainAssignees : projectAssignees;
  const assignees = options.assignees.length ? options.assignees : catalogAssignees;
  const issue = {
    bugId: bug.id,
    projectPath: DEFAULT_ISSUE_HUB_PROJECT_PATH,
    hubProjectPath: DEFAULT_ISSUE_HUB_PROJECT_PATH,
    bindingStatus,
    sourceProjectPath,
    businessProjectPath,
    projectId: project?.id ?? '',
    projectName: project?.name ?? '',
    branch,
    assignee: formatAssignees(assignees),
    assignees,
    assigneeSource: options.assignees.length ? 'manual' : assignees.length ? 'catalog' : 'gitlab-current-user',
    labels,
    severity: bug.severity,
    domain,
    bugTitle: bug.title,
    title: `[${bug.severity}] ${domain} - ${bug.title}`,
    exportPath: bug.exportPath ?? '',
    sourceUrl: bug.sourceUrl,
    finalUrl: bug.finalUrl
  };
  return {
    ...issue,
    description: renderIssueDescription(issue, markdown)
  };
}

function compareIssuePayloads(a: ReturnType<typeof issuePayloadFromDetail>, b: ReturnType<typeof issuePayloadFromDetail>) {
  return a.domain.localeCompare(b.domain)
    || a.bugTitle.localeCompare(b.bugTitle)
    || severityRank(a.severity) - severityRank(b.severity);
}

function severityRank(value: string): number {
  return ({ P0: 0, P1: 1, P2: 2, P3: 3 } as Record<string, number>)[value] ?? 99;
}

function renderIssueDraftMarkdown(issues: Array<ReturnType<typeof issuePayloadFromDetail>>) {
  return `# GitLab Issue Drafts\n\n${issues.map((issue, index) => `## ${index + 1}. ${issue.title}\n\n- Issue Hub: ${issue.projectPath}\n- Binding Status: ${issue.bindingStatus}\n- Business Project: ${issue.projectName || 'not configured'}${issue.projectId ? ` (${issue.projectId})` : ''}\n- Business Repo: ${issue.sourceProjectPath || 'not configured'}\n- Business Issue Project: ${issue.businessProjectPath || 'not configured'}\n- Domain: ${issue.domain}\n- Branch: ${issue.branch || 'not configured'}\n${renderAssigneeSuggestionLine(issue)}\n- Labels: ${issue.labels.join(', ')}\n- Export: ${issue.exportPath}\n- Source: ${issue.sourceUrl}\n\n${issue.description}`).join('\n\n---\n\n')}\n`;
}

function renderIssueDescription(issue: {
  projectPath: string;
  bindingStatus: string;
  projectId: string;
  projectName: string;
  sourceProjectPath: string;
  businessProjectPath: string;
  domain: string;
  branch: string;
  assignee: string;
  assignees: string[];
  assigneeSource: string;
  labels: string[];
  exportPath: string;
  sourceUrl: string;
  finalUrl: string;
}, markdown: string): string {
  return `## Markit Routing\n\n- Issue Hub: ${issue.projectPath}\n- Binding Status: ${issue.bindingStatus}\n- Markit Project: ${issue.projectName || 'not configured'}${issue.projectId ? ` (${issue.projectId})` : ''}\n- Bound Domain: ${issue.domain}\n- Current Branch: ${issue.branch || 'not configured'}\n- Business Repo: ${issue.sourceProjectPath || 'not configured'}\n- Business Issue Project: ${issue.businessProjectPath || 'not configured'}\n${renderAssigneeSuggestionLine(issue)}\n- Labels: ${issue.labels.join(', ')}\n- Export Path: ${issue.exportPath}\n- Source URL: ${issue.sourceUrl}\n- Final URL: ${issue.finalUrl}\n\n---\n\n${markdown}\n`;
}

function renderAssigneeSuggestionLine(issue: { assignee: string; assignees: string[]; assigneeSource: string }): string {
  if (!issue.assignee) return '- Assignee Suggestion: not configured';
  const label = issue.assignees.length > 1 ? 'Assignee Suggestions' : 'Assignee Suggestion';
  const source = issue.assigneeSource === 'manual' ? ' (manual override)' : '';
  return `- ${label}: ${issue.assignee}${source}`;
}

function safeHost(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function safeHostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value)) ?? '';
}

function renderMarkdown(detail: { bug: ReturnType<typeof mapBug>; annotations: unknown[]; assets?: ReturnType<typeof mapBugAsset>[]; projectSnapshot?: any }, groups: Map<string, Row[]>): string {
  const bug = detail.bug;
  const project = detail.projectSnapshot?.project;
  const domain = detail.projectSnapshot?.domain;
  const projectLines = project
    ? `- Project: ${project.name} (${project.id})\n- Domain: ${domain?.host ?? 'none'}${domain?.status ? ` / ${domain.status}` : ''}\n- Branch: ${project.activeBranch ?? domain?.activeBranch ?? 'none'}\n- Business GitLab: ${project.issueProjectPath ?? project.gitlabPath ?? 'none'}\n`
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
