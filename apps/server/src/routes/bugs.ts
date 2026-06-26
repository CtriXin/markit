import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
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
const DEFAULT_FEISHU_BASE_URL = 'https://open.feishu.cn';
const DEFAULT_FEISHU_BASE_TOKEN = 'I7m2bnPDgaYnwksqp1jcmmW9nOd';
const DEFAULT_FEISHU_TABLE_ID = 'tbl0yrCubWcpZCvw';
const DEFAULT_FEISHU_ATTACHMENT_FIELD_ID = 'fldKBwIUX2';
const gitLabUploadLimit = 20;
const issueSubmitLocks = new Map<string, Promise<unknown>>();

type IssueProjectSnapshot = {
  project?: {
    id?: string;
    name?: string;
    status?: string;
    scmpService?: string;
    issueProjectPath?: string;
    gitlabPath?: string;
    localFolderHint?: string;
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
  feishuSync?: FeishuSyncResult;
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

type FeishuSyncResult = {
  status: 'created' | 'skipped' | 'failed';
  recordId?: string;
  reason?: string;
  error?: string;
  attachmentFileTokens?: string[];
  attachmentError?: string;
  syncedAt?: string;
};

type FeishuAuth = { kind: 'token'; token: string } | { kind: 'lark-cli'; as: 'user' | 'bot' };

type FeishuConfig = {
  baseUrl: string;
  baseToken: string;
  tableId: string;
  attachmentFieldId: string;
  ownerOpenIds: string[];
  auth?: FeishuAuth;
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
  const acceptanceRows = atomicAcceptanceRowsFromDetail(detail, groups);
  const acceptanceByAnnotationId = new Map(acceptanceRows.map((row) => [row.annotationId, row]));
  for (const captureId of captureIds) {
    const annotations = groups.get(captureId) ?? [];
    const capture = first(context.database.db, 'SELECT * FROM captures WHERE id = ?', [captureId]);
    if (!capture) continue;
    const captureDir = join(exportDir, 'captures', captureId);
    const cropDir = join(captureDir, 'crops');
    await rm(cropDir, { recursive: true, force: true });
    await mkdir(cropDir, { recursive: true });
    if (annotations.length) {
      const png = PNG.sync.read(await readFile(String(capture.screenshot_path)));
      for (const annotation of annotations) {
        const row = acceptanceByAnnotationId.get(String(annotation.id));
        drawAnnotation(png, annotation, row?.code);
        await writeCrop(png, annotation, join(cropDir, `${row?.code ?? annotation.id}-${annotation.id}.png`));
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
  await writeFile(join(exportDir, 'atomic-acceptance.md'), renderAtomicAcceptanceMarkdown(acceptanceRows, detail.bug.title));
  await writeFile(join(exportDir, 'agent-packet.json'), JSON.stringify(agentPacketFromDetail(detail, acceptanceRows), null, 2));
  await writeFile(join(exportDir, 'bug.json'), JSON.stringify({ ...detail, atomicAcceptance: acceptanceRows }, null, 2));
  await writeFile(join(exportDir, 'requirement-atoms.json'), JSON.stringify(requirementAtomLedgerFromDetail(detail, groups), null, 2));
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
  // Provenance writeback (docs/atom-output-contract.md): exportBug ran during
  // writeIssueDraft BEFORE the GitLab issue existed, so requirement-atoms.json was
  // written with source.ref = null. submitted.json now persists the iid (+ any
  // Feishu attachment tokens), which existingSubmissionsForBugs reads back — so
  // re-export each submitted bug to stamp gl:<iid> / feishu:<token> into the atom
  // ledger (exports/<bugId>/requirement-atoms.json, a stable path it overwrites).
  // Best-effort: the submit already succeeded; a writeback failure must not fail it.
  const writebackBugIds = [...new Set(
    submissions.map((submission) => (submission as { bugId?: string }).bugId).filter((bugId): bugId is string => Boolean(bugId))
  )];
  for (const bugId of writebackBugIds) {
    try {
      await exportBug(context, bugId);
    } catch (error) {
      console.warn(`requirement-atoms provenance writeback failed for ${bugId}: ${String(error)}`);
    }
  }
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
    if (assigneePlan) description = withAssigneeResolutionWarning(description, assigneePlan, 'unchanged');
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
    uploadedEvidence: submission.uploadedEvidence ?? [],
    ...(submission.feishuSync ? { feishuSync: normalizeFeishuSyncResult(submission.feishuSync) } : {})
  };
  if (assigneeIds?.length) normalized.assigneeIds = assigneeIds;
  if (unresolvedAssignees.length) normalized.unresolvedAssignees = unresolvedAssignees;
  return normalized;
}

function normalizeFeishuSyncResult(value: unknown): FeishuSyncResult {
  const input = value && typeof value === 'object' ? value as Partial<FeishuSyncResult> : {};
  const status = ['created', 'skipped', 'failed'].includes(String(input.status)) ? input.status as FeishuSyncResult['status'] : 'skipped';
  return {
    status,
    ...(input.recordId ? { recordId: String(input.recordId) } : {}),
    ...(input.reason ? { reason: String(input.reason) } : {}),
    ...(input.error ? { error: String(input.error) } : {}),
    ...(Array.isArray(input.attachmentFileTokens) ? { attachmentFileTokens: input.attachmentFileTokens.map(String) } : {}),
    ...(input.attachmentError ? { attachmentError: String(input.attachmentError) } : {}),
    ...(input.syncedAt ? { syncedAt: String(input.syncedAt) } : {})
  };
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
    const feishuSync = await maybeSyncFeishuIssue(issue, result);
    if (feishuSync) result.feishuSync = feishuSync;
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

async function maybeSyncFeishuIssue(issue: IssuePayload, result: GitLabIssueResult): Promise<FeishuSyncResult | undefined> {
  if (!envEnabled(process.env.MARKIT_FEISHU_SYNC)) return undefined;
  const syncedAt = nowIso();
  const config = feishuConfigFromEnv(process.env);
  if (!config.auth) return { status: 'skipped', reason: 'feishu_auth_missing', syncedAt };
  try {
    const recordId = await createFeishuRecord(config, issue, result);
    const attachments = await maybeUploadFeishuAttachments(config, recordId, result);
    return {
      status: 'created',
      recordId,
      ...(attachments.fileTokens.length ? { attachmentFileTokens: attachments.fileTokens } : {}),
      ...(attachments.error ? { attachmentError: attachments.error } : {}),
      syncedAt
    };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error), syncedAt };
  }
}

function feishuConfigFromEnv(env: NodeJS.ProcessEnv): FeishuConfig {
  const authMode = String(env.MARKIT_FEISHU_AUTH || 'auto').toLowerCase();
  const token = firstNonEmpty(env.MARKIT_FEISHU_ACCESS_TOKEN, env.MARKIT_LARK_ACCESS_TOKEN, env.FEISHU_ACCESS_TOKEN, env.LARK_ACCESS_TOKEN);
  const cliAs = String(env.MARKIT_FEISHU_CLI_AS || 'user').toLowerCase() === 'bot' ? 'bot' : 'user';
  const auth = token && authMode !== 'lark-cli' && authMode !== 'cli'
    ? { kind: 'token', token } as FeishuAuth
    : authMode === 'token'
      ? undefined
      : { kind: 'lark-cli', as: cliAs } as FeishuAuth;
  return {
    baseUrl: String(env.MARKIT_FEISHU_BASE_URL || DEFAULT_FEISHU_BASE_URL).replace(/\/+$/, ''),
    baseToken: firstNonEmpty(env.MARKIT_FEISHU_BASE_TOKEN, env.FEISHU_BASE_TOKEN, DEFAULT_FEISHU_BASE_TOKEN),
    tableId: firstNonEmpty(env.MARKIT_FEISHU_TABLE_ID, env.FEISHU_TABLE_ID, DEFAULT_FEISHU_TABLE_ID),
    attachmentFieldId: firstNonEmpty(env.MARKIT_FEISHU_ATTACHMENT_FIELD_ID, env.FEISHU_ATTACHMENT_FIELD_ID, DEFAULT_FEISHU_ATTACHMENT_FIELD_ID),
    ownerOpenIds: normalizeAssignees(firstNonEmpty(env.MARKIT_FEISHU_OWNER_OPEN_IDS, env.FEISHU_OWNER_OPEN_IDS)),
    ...(auth ? { auth } : {})
  };
}

function envEnabled(value: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
}

async function createFeishuRecord(config: FeishuConfig, issue: IssuePayload, result: GitLabIssueResult): Promise<string> {
  if (config.auth?.kind === 'lark-cli') return await createFeishuRecordWithLarkCli({ ...config, auth: config.auth }, issue, result);
  if (!config.auth) throw new MarkitHttpError(424, 'feishu_auth_missing', 'Missing Feishu token or lark-cli auth.');
  const response = await fetch(`${config.baseUrl}/open-apis/bitable/v1/apps/${encodeURIComponent(config.baseToken)}/tables/${encodeURIComponent(config.tableId)}/records`, {
    method: 'POST',
    headers: {
      authorization: feishuAuthorizationHeader(config.auth.token),
      'content-type': 'application/json'
    },
    body: JSON.stringify({ fields: feishuFieldsForIssue(issue, result, config) })
  });
  const text = await response.text();
  if (!response.ok) throw new MarkitHttpError(502, 'feishu_sync_failed', `Feishu API failed: ${response.status} ${text.slice(0, 240)}`);
  const payload = parseJson<{ code?: number; msg?: string; data?: { record?: { record_id?: string }; record_id?: string } }>(text, {});
  if (payload.code && payload.code !== 0) throw new MarkitHttpError(502, 'feishu_sync_failed', `Feishu API failed: ${payload.code} ${payload.msg ?? ''}`.trim());
  return payload.data?.record?.record_id ?? payload.data?.record_id ?? '';
}

function createFeishuRecordWithLarkCli(config: FeishuConfig & { auth: { kind: 'lark-cli'; as: 'user' | 'bot' } }, issue: IssuePayload, result: GitLabIssueResult): Promise<string> {
  return new Promise((resolve, reject) => {
    const path = `/open-apis/bitable/v1/apps/${config.baseToken}/tables/${config.tableId}/records`;
    const body = JSON.stringify({ fields: feishuFieldsForIssue(issue, result, config) });
    const args = ['api', 'POST', path, '--as', config.auth.as, '--format', 'json', '--data', '-'];
    const child = spawn('lark-cli', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new MarkitHttpError(504, 'feishu_sync_failed', 'lark-cli api timed out while creating Feishu Base record.'));
    }, 60_000);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(new MarkitHttpError(424, 'feishu_auth_missing', 'lark-cli not found. Install lark-cli or set MARKIT_FEISHU_ACCESS_TOKEN.'));
        return;
      }
      reject(new MarkitHttpError(502, 'feishu_sync_failed', `lark-cli api failed: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new MarkitHttpError(502, 'feishu_sync_failed', `lark-cli api failed: ${(errorOutput || output).trim().slice(0, 240) || 'unknown error'}`));
        return;
      }
      try {
        const payload = output ? JSON.parse(output) as { code?: number; msg?: string; data?: { record?: { record_id?: string }; record_id?: string } } : {};
        if (payload.code && payload.code !== 0) {
          reject(new MarkitHttpError(502, 'feishu_sync_failed', `lark-cli api failed: ${payload.code} ${payload.msg ?? ''}`.trim()));
          return;
        }
        resolve(payload.data?.record?.record_id ?? payload.data?.record_id ?? '');
      } catch (error) {
        reject(new MarkitHttpError(502, 'feishu_sync_failed', `lark-cli api returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.end(body);
  });
}

async function maybeUploadFeishuAttachments(config: FeishuConfig, recordId: string, result: GitLabIssueResult): Promise<{ fileTokens: string[]; error?: string }> {
  if (!recordId || !config.auth) return { fileTokens: [] };
  const filePaths = result.uploadedEvidence.map((item) => item.filePath).filter(Boolean);
  const fileTokens: string[] = [];
  for (const filePath of filePaths) {
    try {
      const tokens = config.auth.kind === 'lark-cli'
        ? await uploadFeishuAttachmentWithLarkCli({ ...config, auth: config.auth }, recordId, filePath)
        : await uploadFeishuAttachmentWithToken({ ...config, auth: config.auth }, recordId, filePath);
      fileTokens.push(...tokens);
    } catch (error) {
      return { fileTokens, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { fileTokens };
}

async function uploadFeishuAttachmentWithToken(config: FeishuConfig & { auth: { kind: 'token'; token: string } }, recordId: string, filePath: string): Promise<string[]> {
  const attachment = await uploadFeishuMedia(config, filePath);
  await appendFeishuAttachment(config, recordId, attachment);
  return [attachment.fileToken];
}

async function uploadFeishuMedia(config: FeishuConfig & { auth: { kind: 'token'; token: string } }, filePath: string): Promise<{ fileToken: string; imageWidth?: number; imageHeight?: number }> {
  const file = await readFile(filePath);
  const metadata = await stat(filePath);
  const image = imageSize(filePath, file);
  const form = new FormData();
  form.append('file_name', basename(filePath));
  form.append('parent_type', 'bitable_file');
  form.append('parent_node', config.baseToken);
  form.append('size', String(metadata.size));
  form.append('file', new Blob([file], { type: mimeTypeForFile(filePath) }), basename(filePath));
  const response = await fetch(`${config.baseUrl}/open-apis/drive/v1/medias/upload_all`, {
    method: 'POST',
    headers: { authorization: feishuAuthorizationHeader(config.auth.token) },
    body: form
  });
  const text = await response.text();
  if (!response.ok) throw new MarkitHttpError(502, 'feishu_attachment_failed', `Feishu media upload failed: ${response.status} ${text.slice(0, 240)}`);
  const payload = parseJson<{ code?: number; msg?: string; data?: { file_token?: string } }>(text, {});
  if (payload.code && payload.code !== 0) throw new MarkitHttpError(502, 'feishu_attachment_failed', `Feishu media upload failed: ${payload.code} ${payload.msg ?? ''}`.trim());
  const fileToken = payload.data?.file_token;
  if (!fileToken) throw new MarkitHttpError(502, 'feishu_attachment_failed', 'Feishu media upload response did not include file_token.');
  return {
    fileToken,
    ...(image ? { imageWidth: image.width, imageHeight: image.height } : {})
  };
}

async function appendFeishuAttachment(config: FeishuConfig & { auth: { kind: 'token'; token: string } }, recordId: string, attachment: { fileToken: string; imageWidth?: number; imageHeight?: number }): Promise<void> {
  const response = await fetch(`${config.baseUrl}/open-apis/base/v3/bases/${encodeURIComponent(config.baseToken)}/tables/${encodeURIComponent(config.tableId)}/append_attachments`, {
    method: 'POST',
    headers: {
      authorization: feishuAuthorizationHeader(config.auth.token),
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      attachments: {
        [recordId]: {
          [config.attachmentFieldId]: [{
            file_token: attachment.fileToken,
            ...(attachment.imageWidth ? { image_width: attachment.imageWidth } : {}),
            ...(attachment.imageHeight ? { image_height: attachment.imageHeight } : {})
          }]
        }
      }
    })
  });
  const text = await response.text();
  if (!response.ok) throw new MarkitHttpError(502, 'feishu_attachment_failed', `Feishu append attachment failed: ${response.status} ${text.slice(0, 240)}`);
  const payload = parseJson<{ code?: number; msg?: string }>(text, {});
  if (payload.code && payload.code !== 0) throw new MarkitHttpError(502, 'feishu_attachment_failed', `Feishu append attachment failed: ${payload.code} ${payload.msg ?? ''}`.trim());
}

function uploadFeishuAttachmentWithLarkCli(config: FeishuConfig & { auth: { kind: 'lark-cli'; as: 'user' | 'bot' } }, recordId: string, filePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const args = [
      'base',
      '+record-upload-attachment',
      '--base-token',
      config.baseToken,
      '--table-id',
      config.tableId,
      '--record-id',
      recordId,
      '--field-id',
      config.attachmentFieldId,
      '--file',
      `./${basename(filePath)}`,
      '--as',
      config.auth.as,
      '--format',
      'json'
    ];
    const child = spawn('lark-cli', args, { cwd: dirname(filePath) || '.', stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new MarkitHttpError(504, 'feishu_attachment_failed', 'lark-cli timed out while uploading Feishu Base attachment.'));
    }, 60_000);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT') {
        reject(new MarkitHttpError(424, 'feishu_auth_missing', 'lark-cli not found. Install lark-cli or set MARKIT_FEISHU_ACCESS_TOKEN.'));
        return;
      }
      reject(new MarkitHttpError(502, 'feishu_attachment_failed', `lark-cli attachment upload failed: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code !== 0) {
        reject(new MarkitHttpError(502, 'feishu_attachment_failed', `lark-cli attachment upload failed: ${(errorOutput || output).trim().slice(0, 240) || 'unknown error'}`));
        return;
      }
      try {
        const payload = parseCliJson<{ data?: { attachments?: Record<string, Record<string, Array<{ file_token?: string }>>> } }>(output);
        const fields = payload.data?.attachments?.[recordId] ?? {};
        const tokens = Object.values(fields).flat().map((item) => item.file_token).filter(Boolean) as string[];
        resolve(tokens);
      } catch (error) {
        reject(new MarkitHttpError(502, 'feishu_attachment_failed', `lark-cli attachment upload returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

function parseCliJson<T>(output: string): T {
  const start = output.indexOf('{');
  if (start < 0) throw new Error('missing JSON object');
  return JSON.parse(output.slice(start)) as T;
}

function imageSize(filePath: string, file: Buffer): { width: number; height: number } | undefined {
  if (extname(filePath).toLowerCase() !== '.png') return undefined;
  try {
    const png = PNG.sync.read(file);
    return { width: png.width, height: png.height };
  } catch {
    return undefined;
  }
}

function feishuAuthorizationHeader(token: string): string {
  return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
}

function feishuFieldsForIssue(issue: IssuePayload, result: GitLabIssueResult, config: FeishuConfig): Record<string, unknown> {
  const serviceOrProject = issue.scmpService || issue.projectName || issue.projectId || repoLabelValue(issue.sourceProjectPath || issue.businessProjectPath) || issue.domain;
  const fields: Record<string, unknown> = {
    '域名或模板名称': `${serviceOrProject} / ${issue.domain}`,
    '问题现象': feishuProblemText(issue),
    '链接': [
      `[GitLab Work Item](${result.workItemUrl})`,
      `[Final URL](${issue.finalUrl})`,
      `[Source URL](${issue.sourceUrl})`
    ].join('\n'),
    '优先级': feishuPriority(issue.severity),
    '项目状态': '已创建',
    comment: issue.bugTitle,
    '备注': feishuNotes(issue, result)
  };
  if (config.ownerOpenIds.length) fields['负责人'] = config.ownerOpenIds.map((id) => ({ id }));
  return fields;
}

function feishuProblemText(issue: IssuePayload): string {
  return [
    issue.bugTitle,
    issue.actual ? `Actual: ${issue.actual}` : '',
    issue.expected ? `Expected: ${issue.expected}` : '',
    issue.tags.length ? `Tags: ${issue.tags.join(', ')}` : ''
  ].filter(Boolean).join('\n');
}

function feishuPriority(severity: string): string {
  const priorities: Record<string, string> = {
    P0: 'P0(需要短时间内修复)',
    P1: 'P1(需要1天内修复)',
    P2: 'P2(记得修复)',
    P3: 'P3(优化项)'
  };
  return priorities[severity] ?? severity;
}

function feishuNotes(issue: IssuePayload, result: GitLabIssueResult): string {
  const evidenceLinks = result.uploadedEvidence
    .map((item) => item.assetUrl ?? item.fullPath ?? item.url)
    .filter(Boolean);
  return [
    `Markit bugId: ${issue.bugId}`,
    `Project: ${issue.projectName || issue.projectId || 'not configured'}`,
    `SCMP Service: ${issue.scmpService || 'not configured'}`,
    `Business Repo: ${issue.sourceProjectPath || 'not configured'}`,
    `Local Folder Hint: ${issue.localFolderHint || 'not configured'}`,
    `Business Issue Project: ${issue.businessProjectPath || 'not configured'}`,
    `Branch: ${issue.branch || 'not configured'}`,
    `GitLab IID: ${result.iid}`,
    evidenceLinks.length ? `Evidence: ${evidenceLinks.join('\n')}` : ''
  ].filter(Boolean).join('\n');
}

function withResolvedAssignee(description: string, configuredAssignees: string[], assignees: string[]): string {
  if (configuredAssignees.length || !assignees.length) return description;
  return description.replace('- Assignee Suggestion: not configured', `- Assignee Suggestion: ${formatAssignees(assignees)} (default current GitLab user)`);
}

function withAssigneeResolutionWarning(description: string, plan: IssueAssigneePlan, emptyAppliedLabel = 'none'): string {
  const cleaned = removeAssigneeResolutionWarning(description);
  if (!plan.unresolvedAssignees.length) return cleaned;
  const applied = plan.assignees.length ? formatAssignees(plan.assignees) : emptyAppliedLabel;
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

function buildIssueLabels(input: { baseLabels: string[]; bindingStatus: string; severity: string; domain: string; projectId: string | undefined; service: string | undefined; repoPath: string | undefined; tags: string[] | undefined }): string[] {
  return [...new Set([
    ...input.baseLabels,
    input.bindingStatus === 'unbound' ? 'unbound-project' : '',
    input.severity,
    issueLabel('project', input.projectId),
    issueLabel('service', input.service),
    issueLabel('repo', repoLabelValue(input.repoPath)),
    issueLabel('domain', input.domain),
    ...((input.tags ?? []).map((tag) => issueLabel('type', tag))),
    input.domain
  ].filter(Boolean))];
}

function issueLabel(prefix: string, value: unknown): string {
  const normalized = labelValue(value);
  return normalized ? `${prefix}:${normalized}` : '';
}

function labelValue(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/g, '')
    .replace(/\.git$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function repoLabelValue(value: unknown): string {
  const raw = String(value ?? '').trim();
  const withoutGitSuffix = raw.replace(/\.git$/i, '');
  const sshPath = withoutGitSuffix.match(/^[^@]+@[^:]+:(.+)$/)?.[1];
  const urlPath = withoutGitSuffix.match(/^https?:\/\/[^/]+\/(.+)$/i)?.[1];
  return labelValue(sshPath ?? urlPath ?? withoutGitSuffix);
}

function gitLabProjectPathValue(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const withoutGitSuffix = raw.replace(/\.git$/i, '');
  const sshPath = withoutGitSuffix.match(/^[^@]+@[^:]+:(.+)$/)?.[1];
  const urlPath = withoutGitSuffix.match(/^https?:\/\/[^/]+\/(.+)$/i)?.[1];
  return (sshPath ?? urlPath ?? withoutGitSuffix).replace(/^\/+|\/+$/g, '');
}

function issuePayloadFromDetail(detail: Awaited<ReturnType<typeof bugDetail>>, markdown: string, options: IssueSubmitOptions = { assignees: [] }) {
  const bug = detail.bug;
  const snapshot = detail.projectSnapshot as IssueProjectSnapshot | undefined;
  const project = snapshot?.project;
  const domain = snapshot?.domain?.host ?? safeHost(bug.finalUrl);
  const branch = project?.activeBranch ?? snapshot?.domain?.activeBranch ?? '';
  const businessProjectPath = gitLabProjectPathValue(project?.issueProjectPath ?? project?.gitlabPath);
  const sourceProjectPath = gitLabProjectPathValue(project?.gitlabPath ?? project?.issueProjectPath);
  const localFolderHint = project?.localFolderHint ?? '';
  const scmpService = project?.scmpService ?? '';
  const bindingStatus = project ? 'bound' : 'unbound';
  const labels = buildIssueLabels({
    baseLabels: project?.labels ?? ['markit', 'bug'],
    bindingStatus,
    severity: bug.severity,
    domain,
    projectId: project?.id,
    service: scmpService,
    repoPath: sourceProjectPath || businessProjectPath,
    tags: bug.tags
  });
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
    localFolderHint,
    projectId: project?.id ?? '',
    projectName: project?.name ?? '',
    scmpService,
    branch,
    assignee: formatAssignees(assignees),
    assignees,
    assigneeSource: options.assignees.length ? 'manual' : assignees.length ? 'catalog' : 'gitlab-current-user',
    labels,
    severity: bug.severity,
    domain,
    actual: bug.actual,
    expected: bug.expected,
    tags: bug.tags,
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
  return `# GitLab Issue Drafts\n\n${issues.map((issue, index) => `## ${index + 1}. ${issue.title}\n\n- Issue Hub: ${issue.projectPath}\n- Binding Status: ${issue.bindingStatus}\n- Business Project: ${issue.projectName || 'not configured'}${issue.projectId ? ` (${issue.projectId})` : ''}\n- Business Repo: ${issue.sourceProjectPath || 'not configured'}\n- Local Folder Hint: ${issue.localFolderHint || 'not configured'}\n- Business Issue Project: ${issue.businessProjectPath || 'not configured'}\n- Domain: ${issue.domain}\n- Branch: ${issue.branch || 'not configured'}\n${renderAssigneeSuggestionLine(issue)}\n- Labels: ${issue.labels.join(', ')}\n- Export: ${issue.exportPath}\n- Source: ${issue.sourceUrl}\n\n${issue.description}`).join('\n\n---\n\n')}\n`;
}

function renderIssueDescription(issue: {
  bugId: string;
  projectPath: string;
  bindingStatus: string;
  projectId: string;
  projectName: string;
  scmpService: string;
  sourceProjectPath: string;
  businessProjectPath: string;
  localFolderHint: string;
  domain: string;
  branch: string;
  assignee: string;
  assignees: string[];
  assigneeSource: string;
  labels: string[];
  exportPath: string;
  sourceUrl: string;
  finalUrl: string;
  severity: string;
  actual: string;
  expected: string;
  tags: string[];
}, markdown: string): string {
  return `${renderMarkitIssueMetadata(issue)}\n\n## Markit Routing\n\n- Issue Hub: ${issue.projectPath}\n- Binding Status: ${issue.bindingStatus}\n- Markit Project: ${issue.projectName || 'not configured'}${issue.projectId ? ` (${issue.projectId})` : ''}\n- SCMP Service: ${issue.scmpService || 'not configured'}\n- Bound Domain: ${issue.domain}\n- Current Branch: ${issue.branch || 'not configured'}\n- Business Repo: ${issue.sourceProjectPath || 'not configured'}\n- Local Folder Hint: ${issue.localFolderHint || 'not configured'}\n- Business Issue Project: ${issue.businessProjectPath || 'not configured'}\n${renderAssigneeSuggestionLine(issue)}\n- Labels: ${issue.labels.join(', ')}\n- Export Path: ${issue.exportPath}\n- Source URL: ${issue.sourceUrl}\n- Final URL: ${issue.finalUrl}\n\n---\n\n${markdown}\n`;
}

function renderMarkitIssueMetadata(issue: {
  bugId: string;
  projectPath: string;
  bindingStatus: string;
  projectId: string;
  projectName: string;
  scmpService: string;
  sourceProjectPath: string;
  businessProjectPath: string;
  localFolderHint: string;
  domain: string;
  branch: string;
  labels: string[];
  exportPath: string;
  sourceUrl: string;
  finalUrl: string;
  severity: string;
  tags: string[];
}): string {
  const metadata = {
    schema: 'markit.gitlab-issue.v1',
    origin: 'markit-server',
    bugId: issue.bugId,
    issueHub: issue.projectPath,
    bindingStatus: issue.bindingStatus,
    projectId: issue.projectId,
    projectName: issue.projectName,
    scmpService: issue.scmpService,
    businessRepo: issue.sourceProjectPath,
    businessIssueProject: issue.businessProjectPath,
    localFolderHint: issue.localFolderHint,
    domain: issue.domain,
    branch: issue.branch,
    severity: issue.severity,
    tags: issue.tags,
    labels: issue.labels,
    exportPath: issue.exportPath,
    sourceUrl: issue.sourceUrl,
    finalUrl: issue.finalUrl
  };
  return `<!-- markit:issue:v1\n${JSON.stringify(metadata, null, 2)}\n-->`;
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

type AtomicAcceptanceRow = {
  code: string;
  annotationId: string;
  captureId: string;
  viewport: string;
  target: string;
  selector: string;
  actual: string;
  expected: string;
  acceptance: string;
  geometry: string;
  binding: string;
};

function atomicAcceptanceRowsFromDetail(detail: Awaited<ReturnType<typeof bugDetail>>, groups: Map<string, Row[]>): AtomicAcceptanceRow[] {
  const captureById = new Map((detail.captures as Array<{ id: string; viewport?: { name?: string }; imageSize?: { width?: number; height?: number } }>).map((capture) => [capture.id, capture]));
  const rowById = new Map([...groups.values()].flat().map((row) => [String(row.id), row]));
  return (detail.annotations as Array<{ id: string; captureId: string; kind: string; note?: string; geometry?: { captureRect?: { x: number; y: number; width: number; height: number } }; target?: Record<string, unknown> }>).map((annotation, index) => {
    const raw = rowById.get(annotation.id);
    const target = (annotation.target ?? parseJson(raw?.target_json, undefined)) as Record<string, unknown> | undefined;
    const geometry = annotation.geometry ?? parseJson<{ captureRect?: { x: number; y: number; width: number; height: number } }>(raw?.geometry_json, {});
    const rect = geometry.captureRect ?? { x: 0, y: 0, width: 1, height: 1 };
    const capture = captureById.get(annotation.captureId);
    const targetLabel = firstNonEmpty(String(target?.label ?? ''), String(target?.text ?? ''), String(target?.value ?? ''), String(target?.tagName ?? ''), annotation.kind);
    const selector = firstNonEmpty(String(target?.selector ?? ''), 'screenshot-region');
    const acceptanceTarget = target ? selector : '标注截图区域';
    const binding = target
      ? `${String(target.selectorKind ?? 'selector')} · score ${Math.round(Number(target.selectorScore ?? 0))}`
      : 'screenshot-only';
    const viewport = capture
      ? `${capture.viewport?.name ?? 'Viewport'} / ${capture.imageSize?.width ?? '?'}x${capture.imageSize?.height ?? '?'}`
      : 'unknown capture';
    return {
      code: annotationCode(index),
      annotationId: annotation.id,
      captureId: annotation.captureId,
      viewport,
      target: targetLabel,
      selector,
      actual: firstNonEmpty(annotation.note, detail.bug.actual, `${targetLabel} 存在已截图的问题。`),
      expected: firstNonEmpty(detail.bug.expected, '页面应与需求和设计一致。'),
      acceptance: `在 ${viewport} 复查 ${acceptanceTarget}，问题现象消失，截图与期望一致。`,
      geometry: geometryLabel(rect),
      binding
    };
  });
}

function agentPacketFromDetail(detail: Awaited<ReturnType<typeof bugDetail>>, rows: AtomicAcceptanceRow[]) {
  return {
    schema: 'markit.agent-packet.v1',
    createdAt: nowIso(),
    bug: detail.bug,
    projectSnapshot: detail.projectSnapshot,
    atomicAcceptance: rows,
    captures: detail.captures,
    assets: detail.assets
  };
}

// ── requirement_atom.v1 projection ──────────────────────────────────────────
// Maps each Markit annotation to a requirement_atom.v1 atom (shared spine).
// Human minimal core: anchor (non-whole-page) + intent + severity.
// assertion is always null here (AI pre-fills at verify-time or via normalizer).
// Spec: docs/atom-output-contract.md
type RequirementAtomAnchorType = 'element' | 'region' | 'rect' | 'pin' | 'page';

type RequirementAtom = {
  id: string;
  source: {
    kind: 'markit-annotation';
    ref: string | null;
    quote: string;
    anchor: {
      type: RequirementAtomAnchorType;
      value: string;
      route: string | null;
      viewport: 'desktop' | 'mobile' | 'both' | null;
    };
  };
  intent: string;
  severity: string;
  assertion: null;
  evidence_required: false;
  status: 'pending';
  evidence_refs: string[];
};

type RequirementAtomLedger = {
  schema: 'requirement_atom.v1';
  source_ref: string | null;
  task_summary: string | null;
  atoms: RequirementAtom[];
};

function anchorTypeForAnnotationKind(kind: string): RequirementAtomAnchorType {
  if (kind === 'element') return 'element';
  if (kind === 'pin') return 'pin';
  if (kind === 'section') return 'region';
  return 'rect'; // rect, ellipse, freehand → rect
}

function anchorValueForAnnotation(
  kind: string,
  geometry: { captureRect?: { x: number; y: number; width: number; height: number } },
  target: Record<string, unknown> | undefined,
  note: string
): string {
  if (kind === 'element' && target?.selector) return String(target.selector);
  if (kind === 'section') return note || '截图区域';
  const rect = geometry.captureRect ?? { x: 0, y: 0, width: 0, height: 0 };
  return geometryLabel(rect);
}

export function requirementAtomLedgerFromDetail(
  detail: Awaited<ReturnType<typeof bugDetail>>,
  groups: Map<string, Row[]>
): RequirementAtomLedger {
  const bug = detail.bug as {
    id: string;
    title: string;
    actual: string;
    expected: string;
    severity: string;
    finalUrl: string;
    issueSubmission?: { iid?: number; feishuSync?: { attachmentFileTokens?: string[] } };
  };
  const captureById = new Map(
    (detail.captures as Array<{ id: string; finalUrl?: string; url?: string; viewport?: { isMobile?: boolean } }>).map((c) => [c.id, c])
  );
  const rowById = new Map([...groups.values()].flat().map((row) => [String(row.id), row]));

  const shortId = bug.id.replace('bug_', '').slice(0, 8);
  const issueIid = bug.issueSubmission?.iid;
  const sourceRef = issueIid ? `gl:${issueIid}` : null;
  const feishuTokens = bug.issueSubmission?.feishuSync?.attachmentFileTokens ?? [];

  const atoms: RequirementAtom[] = (
    detail.annotations as Array<{
      id: string;
      captureId: string;
      kind: string;
      note?: string;
      geometry?: { captureRect?: { x: number; y: number; width: number; height: number } };
      target?: Record<string, unknown>;
    }>
  ).map((annotation, index) => {
    const raw = rowById.get(annotation.id);
    const target = (annotation.target ?? parseJson(raw?.target_json, undefined)) as Record<string, unknown> | undefined;
    const geometry = annotation.geometry ?? parseJson<{ captureRect?: { x: number; y: number; width: number; height: number } }>(raw?.geometry_json, {});
    const capture = captureById.get(annotation.captureId);
    const note = firstNonEmpty(annotation.note ?? '', bug.title);
    const anchorType = anchorTypeForAnnotationKind(annotation.kind);
    const anchorValue = anchorValueForAnnotation(annotation.kind, geometry, target, note);
    const route = firstNonEmpty(capture?.finalUrl ?? '', capture?.url ?? '', bug.finalUrl) || null;
    const viewport = capture?.viewport?.isMobile ? 'mobile' : 'desktop';
    const atomId = `MKT-${shortId}-${annotationCode(index)}`;
    const evidenceRefs = feishuTokens.length
      ? feishuTokens.map((t) => `feishu:${t}`)
      : [];

    return {
      id: atomId,
      source: {
        kind: 'markit-annotation',
        ref: sourceRef,
        quote: note,
        anchor: {
          type: anchorType,
          value: anchorValue,
          route,
          viewport
        }
      },
      intent: note,
      severity: bug.severity,
      assertion: null,
      evidence_required: false,
      status: 'pending',
      evidence_refs: evidenceRefs
    };
  });

  return {
    schema: 'requirement_atom.v1',
    source_ref: sourceRef,
    task_summary: bug.title,
    atoms
  };
}

function renderAtomicAcceptanceMarkdown(rows: AtomicAcceptanceRow[], title: string): string {
  if (!rows.length) return `# ${title}\n\nNo atomic acceptance rows.\n`;
  return `# ${title}\n\n| ID | 视口 | 对象 | 绑定 | 实际 | 期望 | 验收 |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.map((row) => `| ${row.code} | ${markdownCell(row.viewport)} | ${markdownCell(row.target)} | ${markdownCell(row.binding)} | ${markdownCell(row.actual)} | ${markdownCell(row.expected)} | ${markdownCell(row.acceptance)} |`).join('\n')}\n`;
}

function markdownCell(value: unknown): string {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function annotationCode(index: number): string {
  return `A${String(index + 1).padStart(2, '0')}`;
}

function geometryLabel(rect: { x: number; y: number; width: number; height: number }): string {
  return `x${Math.round(rect.x)} y${Math.round(rect.y)} w${Math.round(rect.width)} h${Math.round(rect.height)}`;
}

function renderMarkdown(detail: Awaited<ReturnType<typeof bugDetail>>, groups: Map<string, Row[]>): string {
  const bug = detail.bug;
  const snapshot = detail.projectSnapshot as IssueProjectSnapshot | undefined;
  const project = snapshot?.project;
  const domain = snapshot?.domain;
  const acceptanceRows = atomicAcceptanceRowsFromDetail(detail, groups);
  const acceptanceByAnnotationId = new Map(acceptanceRows.map((row) => [row.annotationId, row]));
  const projectLines = project
    ? `- Project: ${project.name} (${project.id})\n- Domain: ${domain?.host ?? 'none'}${domain?.status ? ` / ${domain.status}` : ''}\n- Branch: ${project.activeBranch ?? domain?.activeBranch ?? 'none'}\n- Business GitLab: ${project.issueProjectPath ?? project.gitlabPath ?? 'none'}\n- Local Folder Hint: ${project.localFolderHint ?? 'none'}\n`
    : '';
  const references = bug.references.length
    ? `\n## References\n\n${bug.references.map((reference) => `- ${reference.label ?? reference.kind}: ${reference.url}`).join('\n')}\n`
    : '';
  const assets = detail.assets?.length
    ? `\n## Compare Screenshots\n\n${detail.assets.map((asset) => `- ${asset.label || asset.kind}: [${asset.fileName}](assets/${exportedAssetName(asset)})`).join('\n')}\n`
    : '';
  const atomic = acceptanceRows.length ? `\n## Atomic Acceptance\n\n${renderAtomicAcceptanceMarkdown(acceptanceRows, bug.title).replace(/^# .+\n\n/, '')}` : '';
  return `# ${bug.title}\n\n- Severity: ${bug.severity}\n- Status: ${bug.status}\n- Source URL: ${bug.sourceUrl}\n- Final URL: ${bug.finalUrl}\n${projectLines}- Tags: ${bug.tags.join(', ') || 'none'}\n\n## Actual\n\n${bug.actual}\n\n## Expected\n\n${bug.expected}\n${references}${assets}${atomic}\n## Annotations\n\n${[...groups.entries()].map(([captureId, annotations]) => `### ${captureId}\n\n${annotations.map((annotation) => {
    const row = acceptanceByAnnotationId.get(String(annotation.id));
    const target = parseJson<Record<string, unknown>>(annotation.target_json, {});
    const selector = target.selector ? ` · ${target.selector}` : '';
    return `- ${row?.code ?? annotation.id}: ${annotation.note || bug.title}${selector}`;
  }).join('\n')}`).join('\n\n')}\n`;
}

function exportedAssetName(asset: ReturnType<typeof mapBugAsset>): string {
  return `${asset.id}-${asset.fileName}`;
}

function drawAnnotation(png: PNG, annotation: Row, label?: string) {
  const geometry = parseJson<{ captureRect: { x: number; y: number; width: number; height: number }; paths?: Array<Array<{ x: number; y: number }>> }>(annotation.geometry_json, { captureRect: { x: 0, y: 0, width: 1, height: 1 } });
  const rect = geometry.captureRect;
  if (String(annotation.kind) === 'freehand' && geometry.paths) {
    for (const path of geometry.paths) for (const point of path) putDot(png, Math.round(point.x), Math.round(point.y), [229, 72, 77, 255], 2);
  } else if (String(annotation.kind) === 'ellipse') {
    drawEllipse(png, rect, [229, 72, 77, 255]);
  } else {
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
  if (label) drawAnnotationBadge(png, rect, label);
}

function drawAnnotationBadge(png: PNG, rect: { x: number; y: number; width: number; height: number }, label: string) {
  const text = label.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  if (!text) return;
  const scale = 2;
  const paddingX = 4;
  const paddingY = 3;
  const glyphWidth = 3 * scale;
  const glyphHeight = 5 * scale;
  const gap = scale;
  const width = paddingX * 2 + text.length * glyphWidth + (text.length - 1) * gap;
  const height = paddingY * 2 + glyphHeight;
  const x = clampInt(Math.round(rect.x + 4), 1, Math.max(1, png.width - width - 1));
  const y = clampInt(Math.round(rect.y + 4), 1, Math.max(1, png.height - height - 1));
  fillRect(png, x, y, width, height, [22, 119, 255, 255]);
  strokeRect(png, x, y, width, height, [255, 255, 255, 255]);
  let cursor = x + paddingX;
  for (const char of text) {
    drawGlyph(png, char, cursor, y + paddingY, scale, [255, 255, 255, 255]);
    cursor += glyphWidth + gap;
  }
}

const badgeGlyphs: Record<string, string[]> = {
  A: ['010', '101', '111', '101', '101'],
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111']
};

function drawGlyph(png: PNG, char: string, x: number, y: number, scale: number, rgba: [number, number, number, number]) {
  const glyph = badgeGlyphs[char];
  if (!glyph) return;
  for (let row = 0; row < glyph.length; row += 1) {
    for (let col = 0; col < glyph[row]!.length; col += 1) {
      if (glyph[row]![col] !== '1') continue;
      fillRect(png, x + col * scale, y + row * scale, scale, scale, rgba);
    }
  }
}

function fillRect(png: PNG, x: number, y: number, width: number, height: number, rgba: [number, number, number, number]) {
  for (let px = x; px < x + width; px += 1) for (let py = y; py < y + height; py += 1) putPixel(png, px, py, rgba);
}

function strokeRect(png: PNG, x: number, y: number, width: number, height: number, rgba: [number, number, number, number]) {
  for (let px = x; px < x + width; px += 1) {
    putPixel(png, px, y, rgba);
    putPixel(png, px, y + height - 1, rgba);
  }
  for (let py = y; py < y + height; py += 1) {
    putPixel(png, x, py, rgba);
    putPixel(png, x + width - 1, py, rgba);
  }
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
