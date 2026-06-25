import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { createApp } from '../src/app.js';
import { createServerContext, type ServerContext } from '../src/context.js';

let fixtureServer: Server;
let apiServer: Server;
let context: ServerContext;
let dataDir: string;
let fixtureBaseUrl: string;
let apiBaseUrl: string;
const gitLabApiRequests: Array<{ method: string; url: string; body: string }> = [];
const feishuApiRequests: Array<{ method: string; url: string; body: string; authorization?: string }> = [];
const projectSnapshot = {
  schema: 'markit.project-snapshot.v1',
  source: 'client',
  capturedAt: '2026-06-17T00:00:00.000Z',
  project: {
    id: 'ptc-demo',
    name: 'Demo Project',
    status: 'active',
    scmpService: 'ptc-demo-service',
    gitlabPath: 'ptc/fe/demo',
    activeBranch: 'release-1.2.3',
    issueProjectPath: 'ptc/fe/demo',
    defaultAssignee: 'xin',
    labels: ['markit', 'bug']
  },
  domain: {
    host: 'demo.example.com',
    url: 'https://demo.example.com',
    env: 'prod',
    status: 'active',
    activeBranch: 'release-1.2.3'
  }
};

function listen(server: Server): Promise<string> {
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      resolveListen(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => server.close((error) => (error ? reject(error) : resolveClose())));
}

describe('session and capture API', () => {
  beforeAll(async () => {
    const fixtureRoot = resolve(import.meta.dirname, '../../../fixtures/test-site');
    fixtureServer = createServer((req, res) => {
      if (req.url?.startsWith('/api/v4/')) {
        void handleGitLabFixture(req, res);
        return;
      }
      if (req.url?.startsWith('/open-apis/')) {
        void handleFeishuFixture(req, res);
        return;
      }
      const urlPath = req.url === '/' ? '/index.html' : req.url || '/index.html';
      const filePath = join(fixtureRoot, urlPath.replace(/^\//, ''));
      res.setHeader('content-type', extname(filePath) === '.html' ? 'text/html' : 'text/plain');
      createReadStream(filePath).on('error', () => {
        res.statusCode = 404;
        res.end('not found');
      }).pipe(res);
    });
    fixtureBaseUrl = await listen(fixtureServer);

    dataDir = await mkdtemp(join(tmpdir(), 'markit-api-'));
    context = await createServerContext({ dataDir });
    apiServer = createApp(context).listen(0, '127.0.0.1');
    apiBaseUrl = await new Promise<string>((resolveApi) => {
      apiServer.once('listening', () => {
        const address = apiServer.address();
        if (!address || typeof address === 'string') throw new Error('Missing api server address');
        resolveApi(`http://127.0.0.1:${address.port}`);
      });
    });
  }, 30_000);

  afterAll(async () => {
    await context.runtime.close();
    await close(apiServer);
    await close(fixtureServer);
    await rm(dataDir, { recursive: true, force: true });
  });

  it('creates a session with first viewport capture and readable image/DOM targets', async () => {
    const response = await fetch(`${apiBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${fixtureBaseUrl}/index.html`,
        viewport: { name: 'Mobile 390x844', width: 390, height: 844, deviceScaleFactor: 2, isMobile: true },
        projectSnapshot
      })
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.session.sourceUrl).toBe(`${fixtureBaseUrl}/index.html`);
    expect(body.session.projectSnapshot).toMatchObject({ project: { id: 'ptc-demo', name: 'Demo Project' }, domain: { host: 'demo.example.com' } });
    expect(body.capture.imageSize).toMatchObject({ width: 390, height: 844 });

    const imageResponse = await fetch(`${apiBaseUrl}/api/captures/${body.capture.id}/image`);
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get('content-type')).toContain('image/png');

    const domResponse = await fetch(`${apiBaseUrl}/api/captures/${body.capture.id}/dom-targets`);
    const targets = await domResponse.json();
    expect(targets.some((target: { selector: string }) => target.selector.includes('mobile-menu'))).toBe(true);

    const annotationResponse = await fetch(`${apiBaseUrl}/api/captures/${body.capture.id}/annotations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'pin', geometry: { captureRect: { x: 10, y: 10, width: 1, height: 1 } }, note: '截图证据验证' })
    });
    const annotationBody = await annotationResponse.json();
    const bugResponse = await fetch(`${apiBaseUrl}/api/bugs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: body.session.id,
        title: '粘贴截图证据',
        actual: '已有测试截图需要作为原始证据。',
        expected: 'Bug 详情和导出应保留截图。',
        severity: 'P2',
        status: 'draft',
        sourceUrl: body.session.sourceUrl,
        finalUrl: body.capture.finalUrl,
        primaryCaptureId: body.capture.id,
        tags: ['layout'],
        annotationIds: [annotationBody.annotation.id],
        assets: [{
          kind: 'pasted-screenshot',
          fileName: 'compare.png',
          mimeType: 'image/png',
          label: '粘贴截图',
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII='
        }]
      })
    });
    expect(bugResponse.status).toBe(201);
    const bugBody = await bugResponse.json();
    expect(bugBody.bug.projectSnapshot).toMatchObject({ project: { id: 'ptc-demo', name: 'Demo Project' }, domain: { host: 'demo.example.com', activeBranch: 'release-1.2.3' } });
    expect(bugBody.assets).toHaveLength(1);
    expect(bugBody.bug.assetCount).toBe(1);
    const linkedAnnotationBody = await fetch(`${apiBaseUrl}/api/captures/${body.capture.id}/annotations`).then((item) => item.json());
    expect(linkedAnnotationBody.annotations.find((annotation: { id: string }) => annotation.id === annotationBody.annotation.id)).toMatchObject({
      linkedBugId: bugBody.bug.id,
      linkedBugTitle: '粘贴截图证据'
    });
    const bugsWithProject = await fetch(`${apiBaseUrl}/api/bugs`).then((item) => item.json());
    expect(bugsWithProject.bugs.find((bug: { id: string }) => bug.id === bugBody.bug.id)?.projectSnapshot).toMatchObject({ project: { id: 'ptc-demo' } });
    const assetResponse = await fetch(`${apiBaseUrl}/api/bug-assets/${bugBody.assets[0].id}/image`);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toContain('image/png');
    const bulkExportResponse = await fetch(`${apiBaseUrl}/api/bugs/bulk-export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bugIds: [bugBody.bug.id] })
    });
    expect(bulkExportResponse.status).toBe(200);
    const bulkExport = await bulkExportResponse.json();
    expect(bulkExport).toMatchObject({ count: 1, exports: [expect.objectContaining({ bugId: bugBody.bug.id })] });
    const issueDraftResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bugIds: [bugBody.bug.id] })
    });
    expect(issueDraftResponse.status).toBe(200);
    const issueDraft = await issueDraftResponse.json();
    expect(issueDraft).toMatchObject({
      mode: 'dry-run',
      count: 1,
      issues: [expect.objectContaining({
        projectPath: 'ptc/fe/ptc-wiki',
        hubProjectPath: 'ptc/fe/ptc-wiki',
        sourceProjectPath: 'ptc/fe/demo',
        businessProjectPath: 'ptc/fe/demo',
        assignee: 'xin'
      })]
    });
    expect(issueDraft.issues[0].labels).toEqual(expect.arrayContaining([
      'project:ptc-demo',
      'service:ptc-demo-service',
      'repo:ptc-fe-demo',
      'domain:demo.example.com',
      'type:layout'
    ]));
    expect(await readFile(issueDraft.jsonPath, 'utf8')).toContain('markit.gitlab-issue-draft.v1');
    const issueMarkdown = await readFile(issueDraft.markdownPath, 'utf8');
    expect(issueMarkdown).toContain('[P2] demo.example.com - 粘贴截图证据');
    expect(issueMarkdown).toContain('markit.gitlab-issue.v1');
    expect(issueMarkdown).toContain('- SCMP Service: ptc-demo-service');
    expect(issueMarkdown).toContain('- Issue Hub: ptc/fe/ptc-wiki');
    expect(issueMarkdown).toContain('- Business Repo: ptc/fe/demo');
    const previousGitLab = {
      auth: process.env.MARKIT_GITLAB_AUTH,
      markit: process.env.MARKIT_GITLAB_TOKEN,
      generic: process.env.GITLAB_TOKEN,
      glab: process.env.GLAB_TOKEN
    };
    process.env.MARKIT_GITLAB_AUTH = 'token';
    delete process.env.MARKIT_GITLAB_TOKEN;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GLAB_TOKEN;
    try {
      const submitResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bugIds: [bugBody.bug.id] })
      });
      expect(submitResponse.status).toBe(424);
      expect(await submitResponse.json()).toMatchObject({ error: { code: 'gitlab_auth_missing' } });
    } finally {
      restoreEnv('MARKIT_GITLAB_AUTH', previousGitLab.auth);
      restoreEnv('MARKIT_GITLAB_TOKEN', previousGitLab.markit);
      restoreEnv('GITLAB_TOKEN', previousGitLab.generic);
      restoreEnv('GLAB_TOKEN', previousGitLab.glab);
    }

    const existingSubmitDir = join(dataDir, 'issue-drafts', 'existing-submit');
    await mkdir(existingSubmitDir, { recursive: true });
    await writeFile(join(existingSubmitDir, 'submitted.json'), JSON.stringify({
      schema: 'markit.gitlab-issue-submit.v1',
      submissions: [{
        bugId: bugBody.bug.id,
        title: '[P2] demo.example.com - 粘贴截图证据',
        projectPath: 'ptc/fe/ptc-wiki',
        iid: 88,
        id: 188,
        webUrl: 'https://gitlab.adsconflux.xyz/ptc/fe/ptc-wiki/-/issues/88',
        workItemUrl: 'https://gitlab.adsconflux.xyz/ptc/fe/ptc-wiki/-/work_items/88',
        assignee: 'xin',
        assigneeResolved: false,
        labels: ['markit', 'bug'],
        uploadedEvidence: [{ filePath: '/tmp/screenshot.png', markdown: '![screenshot](https://gitlab.adsconflux.xyz/ptc/fe/ptc-wiki/uploads/demo/screenshot.png)', assetUrl: 'https://gitlab.adsconflux.xyz/ptc/fe/ptc-wiki/uploads/demo/screenshot.png' }]
      }]
    }));
    process.env.MARKIT_GITLAB_AUTH = 'token';
    delete process.env.MARKIT_GITLAB_TOKEN;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GLAB_TOKEN;
    try {
      const duplicateSubmitResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bugIds: [bugBody.bug.id] })
      });
      expect(duplicateSubmitResponse.status).toBe(200);
      const duplicateSubmit = await duplicateSubmitResponse.json();
      expect(duplicateSubmit).toMatchObject({
        duplicate: true,
        createdCount: 0,
        skippedCount: 1,
        submissions: [expect.objectContaining({ bugId: bugBody.bug.id, iid: 88, reused: true })]
      });
    } finally {
      restoreEnv('MARKIT_GITLAB_AUTH', previousGitLab.auth);
      restoreEnv('MARKIT_GITLAB_TOKEN', previousGitLab.markit);
      restoreEnv('GITLAB_TOKEN', previousGitLab.generic);
      restoreEnv('GLAB_TOKEN', previousGitLab.glab);
    }

    const deleteResponse = await fetch(`${apiBaseUrl}/api/bugs/${bugBody.bug.id}`, { method: 'DELETE' });
    expect(deleteResponse.status).toBe(200);
    const bugsAfterDelete = await fetch(`${apiBaseUrl}/api/bugs`).then((item) => item.json());
    expect(bugsAfterDelete.bugs.some((bug: { id: string }) => bug.id === bugBody.bug.id)).toBe(false);
    const deletedAssetResponse = await fetch(`${apiBaseUrl}/api/bug-assets/${bugBody.assets[0].id}/image`);
    expect(deletedAssetResponse.status).toBe(404);
  }, 30_000);

  it('drafts unbound bugs to the wiki hub with unbound metadata', async () => {
    const createResponse = await fetch(`${apiBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${fixtureBaseUrl}/index.html`, viewport: { name: 'Desktop 800x500', width: 800, height: 500, deviceScaleFactor: 1 } })
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const bugResponse = await fetch(`${apiBaseUrl}/api/bugs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: created.session.id,
        title: '未绑定项目 Bug',
        actual: '直接输入 URL 时没有 catalog 项目绑定。',
        expected: '仍应能挂到统一 Wiki Hub，并标记 unbound。',
        severity: 'P3',
        status: 'draft',
        sourceUrl: created.session.sourceUrl,
        finalUrl: created.capture.finalUrl,
        primaryCaptureId: created.capture.id
      })
    });
    expect(bugResponse.status).toBe(201);
    const bugBody = await bugResponse.json();
    const issueDraftResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bugIds: [bugBody.bug.id] })
    });
    expect(issueDraftResponse.status).toBe(200);
    const issueDraft = await issueDraftResponse.json();
    expect(issueDraft.issues[0]).toMatchObject({
      projectPath: 'ptc/fe/ptc-wiki',
      bindingStatus: 'unbound',
      projectName: '',
      sourceProjectPath: '',
      businessProjectPath: ''
    });
    expect(issueDraft.issues[0].labels).toContain('unbound-project');
    expect(await readFile(issueDraft.markdownPath, 'utf8')).toContain('- Binding Status: unbound');
    const primaryScreenshot = await readFile(join(issueDraft.issues[0].exportPath, 'captures', created.capture.id, 'screenshot.png'));
    expect(primaryScreenshot.length).toBeGreaterThan(0);
  }, 30_000);

  it('assigns GitLab issues to the current user when catalog has no default assignee', async () => {
    const createResponse = await fetch(`${apiBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${fixtureBaseUrl}/index.html`,
        viewport: { name: 'Desktop 800x500', width: 800, height: 500, deviceScaleFactor: 1 },
        projectSnapshot: {
          ...projectSnapshot,
          project: {
            ...projectSnapshot.project,
            id: 'ptc-no-assignee',
            name: 'No Assignee Project',
            defaultAssignee: ''
          },
          domain: {
            ...projectSnapshot.domain,
            host: 'no-assignee.example.com',
            url: 'https://no-assignee.example.com'
          }
        }
      })
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const bugResponse = await fetch(`${apiBaseUrl}/api/bugs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: created.session.id,
        title: '无默认负责人',
        actual: '项目未配置 defaultAssignee。',
        expected: '真实挂载时应默认分配当前 GitLab 用户。',
        severity: 'P2',
        status: 'draft',
        sourceUrl: created.session.sourceUrl,
        finalUrl: created.capture.finalUrl,
        primaryCaptureId: created.capture.id
      })
    });
    expect(bugResponse.status).toBe(201);
    const bugBody = await bugResponse.json();
    const previousGitLab = {
      baseUrl: process.env.MARKIT_GITLAB_BASE_URL,
      auth: process.env.MARKIT_GITLAB_AUTH,
      token: process.env.MARKIT_GITLAB_TOKEN
    };
    gitLabApiRequests.length = 0;
    process.env.MARKIT_GITLAB_BASE_URL = fixtureBaseUrl;
    process.env.MARKIT_GITLAB_AUTH = 'token';
    process.env.MARKIT_GITLAB_TOKEN = 'test-token';
    try {
      const submitResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bugIds: [bugBody.bug.id] })
      });
      expect(submitResponse.status).toBe(200);
      const submitBody = await submitResponse.json();
      expect(submitBody.submissions[0]).toMatchObject({ assignee: 'songxin', assignees: ['songxin'], assigneeIds: [501], assigneeResolved: true });
      const issueRequest = gitLabApiRequests.find((request) => request.method === 'POST' && request.url.includes('/issues'));
      expect(issueRequest).toBeTruthy();
      const issueBody = JSON.parse(issueRequest?.body || '{}');
      expect(issueBody.assignee_ids).toEqual([501]);
      expect(issueBody.description).toContain('Assignee Suggestion: songxin (default current GitLab user)');
    } finally {
      restoreEnv('MARKIT_GITLAB_BASE_URL', previousGitLab.baseUrl);
      restoreEnv('MARKIT_GITLAB_AUTH', previousGitLab.auth);
      restoreEnv('MARKIT_GITLAB_TOKEN', previousGitLab.token);
    }
  }, 30_000);

  it('optionally syncs created GitLab issues to Feishu Base records', async () => {
    const item = await createBugForIssueSubmit('飞书同步字段验证');
    const previous = {
      gitlabBaseUrl: process.env.MARKIT_GITLAB_BASE_URL,
      gitlabAuth: process.env.MARKIT_GITLAB_AUTH,
      gitlabToken: process.env.MARKIT_GITLAB_TOKEN,
      feishuSync: process.env.MARKIT_FEISHU_SYNC,
      feishuBaseUrl: process.env.MARKIT_FEISHU_BASE_URL,
      feishuToken: process.env.MARKIT_FEISHU_ACCESS_TOKEN,
      feishuBaseToken: process.env.MARKIT_FEISHU_BASE_TOKEN,
      feishuTableId: process.env.MARKIT_FEISHU_TABLE_ID,
      feishuOwnerOpenIds: process.env.MARKIT_FEISHU_OWNER_OPEN_IDS
    };
    gitLabApiRequests.length = 0;
    feishuApiRequests.length = 0;
    process.env.MARKIT_GITLAB_BASE_URL = fixtureBaseUrl;
    process.env.MARKIT_GITLAB_AUTH = 'token';
    process.env.MARKIT_GITLAB_TOKEN = 'test-token';
    process.env.MARKIT_FEISHU_SYNC = '1';
    process.env.MARKIT_FEISHU_BASE_URL = fixtureBaseUrl;
    process.env.MARKIT_FEISHU_ACCESS_TOKEN = 'feishu-test-token';
    process.env.MARKIT_FEISHU_OWNER_OPEN_IDS = 'ou_songxin';
    delete process.env.MARKIT_FEISHU_BASE_TOKEN;
    delete process.env.MARKIT_FEISHU_TABLE_ID;
    try {
      const submitResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bugIds: [item.bug.id] })
      });
      expect(submitResponse.status).toBe(200);
      const submitBody = await submitResponse.json();
      expect(submitBody.submissions[0].feishuSync).toMatchObject({ status: 'created', recordId: 'rec_markit_sync', attachmentFileTokens: ['file_markit_sync'] });
      expect(feishuApiRequests).toHaveLength(3);
      const createRequest = feishuApiRequests.find((request) => request.url.includes('/records'));
      const mediaRequest = feishuApiRequests.find((request) => request.url.includes('/medias/upload_all'));
      const appendRequest = feishuApiRequests.find((request) => request.url.includes('/append_attachments'));
      expect(createRequest?.url).toContain('/open-apis/bitable/v1/apps/I7m2bnPDgaYnwksqp1jcmmW9nOd/tables/tbl0yrCubWcpZCvw/records');
      expect(createRequest?.authorization).toBe('Bearer feishu-test-token');
      expect(mediaRequest?.authorization).toBe('Bearer feishu-test-token');
      expect(mediaRequest?.body).toContain('bitable_file');
      expect(mediaRequest?.body).toContain('I7m2bnPDgaYnwksqp1jcmmW9nOd');
      expect(appendRequest?.authorization).toBe('Bearer feishu-test-token');
      const feishuBody = JSON.parse(createRequest?.body || '{}');
      expect(feishuBody.fields).toMatchObject({
        '域名或模板名称': 'ptc-demo-service / demo.example.com',
        '优先级': 'P2(记得修复)',
        '项目状态': '已创建',
        '负责人': [{ id: 'ou_songxin' }],
        comment: '飞书同步字段验证'
      });
      expect(feishuBody.fields['链接']).toContain('/-/work_items/101');
      expect(feishuBody.fields['备注']).toContain('SCMP Service: ptc-demo-service');
      expect(feishuBody.fields['备注']).toContain('Business Repo: ptc/fe/demo');
      const appendBody = JSON.parse(appendRequest?.body || '{}');
      expect(appendBody.attachments.rec_markit_sync.fldKBwIUX2[0]).toMatchObject({ file_token: 'file_markit_sync', image_width: 800, image_height: 500 });
    } finally {
      restoreEnv('MARKIT_GITLAB_BASE_URL', previous.gitlabBaseUrl);
      restoreEnv('MARKIT_GITLAB_AUTH', previous.gitlabAuth);
      restoreEnv('MARKIT_GITLAB_TOKEN', previous.gitlabToken);
      restoreEnv('MARKIT_FEISHU_SYNC', previous.feishuSync);
      restoreEnv('MARKIT_FEISHU_BASE_URL', previous.feishuBaseUrl);
      restoreEnv('MARKIT_FEISHU_ACCESS_TOKEN', previous.feishuToken);
      restoreEnv('MARKIT_FEISHU_BASE_TOKEN', previous.feishuBaseToken);
      restoreEnv('MARKIT_FEISHU_TABLE_ID', previous.feishuTableId);
      restoreEnv('MARKIT_FEISHU_OWNER_OPEN_IDS', previous.feishuOwnerOpenIds);
    }
  }, 30_000);

  it('lets bulk issue submit override catalog assignees with multiple GitLab users', async () => {
    const createResponse = await fetch(`${apiBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        url: `${fixtureBaseUrl}/index.html`,
        viewport: { name: 'Desktop 800x500', width: 800, height: 500, deviceScaleFactor: 1 },
        projectSnapshot
      })
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();
    const bugResponse = await fetch(`${apiBaseUrl}/api/bugs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: created.session.id,
        title: '手动多人分配',
        actual: '批量提交时需要临时换负责人。',
        expected: '请求里的 assignees 应优先于 catalog defaultAssignee。',
        severity: 'P1',
        status: 'draft',
        sourceUrl: created.session.sourceUrl,
        finalUrl: created.capture.finalUrl,
        primaryCaptureId: created.capture.id
      })
    });
    expect(bugResponse.status).toBe(201);
    const bugBody = await bugResponse.json();
    const previousGitLab = {
      baseUrl: process.env.MARKIT_GITLAB_BASE_URL,
      auth: process.env.MARKIT_GITLAB_AUTH,
      token: process.env.MARKIT_GITLAB_TOKEN
    };
    gitLabApiRequests.length = 0;
    process.env.MARKIT_GITLAB_BASE_URL = fixtureBaseUrl;
    process.env.MARKIT_GITLAB_AUTH = 'token';
    process.env.MARKIT_GITLAB_TOKEN = 'test-token';
    try {
      const submitResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bugIds: [bugBody.bug.id], assignees: ['songxin', 'qauser'] })
      });
      expect(submitResponse.status).toBe(200);
      const submitBody = await submitResponse.json();
      expect(submitBody.submissions[0]).toMatchObject({
        assignee: 'songxin, qauser',
        assignees: ['songxin', 'qauser'],
        assigneeIds: [501, 502],
        assigneeResolved: true
      });
      const issueRequest = gitLabApiRequests.find((request) => request.method === 'POST' && request.url.includes('/issues'));
      expect(issueRequest).toBeTruthy();
      const issueBody = JSON.parse(issueRequest?.body || '{}');
      expect(issueBody.assignee_ids).toEqual([501, 502]);
      expect(issueBody.description).toContain('Assignee Suggestions: songxin, qauser (manual override)');
      expect(gitLabApiRequests.some((request) => request.url === '/api/v4/user')).toBe(false);
    } finally {
      restoreEnv('MARKIT_GITLAB_BASE_URL', previousGitLab.baseUrl);
      restoreEnv('MARKIT_GITLAB_AUTH', previousGitLab.auth);
      restoreEnv('MARKIT_GITLAB_TOKEN', previousGitLab.token);
    }
  }, 30_000);

  it('syncs manual assignee overrides to existing issues in a mixed batch', async () => {
    const existingBug = await createBugForIssueSubmit('已有 Issue 也同步负责人');
    const newBug = await createBugForIssueSubmit('新 Issue 同步负责人');
    const existingSubmitDir = join(dataDir, 'issue-drafts', 'existing-mixed-assignee');
    await mkdir(existingSubmitDir, { recursive: true });
    await writeFile(join(existingSubmitDir, 'submitted.json'), JSON.stringify({
      schema: 'markit.gitlab-issue-submit.v1',
      submissions: [{
        bugId: existingBug.bug.id,
        title: '[P2] demo.example.com - 已有 Issue 也同步负责人',
        projectPath: 'ptc/fe/ptc-wiki',
        iid: 77,
        id: 177,
        webUrl: `${fixtureBaseUrl}/ptc/fe/ptc-wiki/-/issues/77`,
        workItemUrl: `${fixtureBaseUrl}/ptc/fe/ptc-wiki/-/work_items/77`,
        assignee: 'xin',
        assignees: ['xin'],
        assigneeIds: [503],
        assigneeResolved: true,
        labels: ['markit', 'bug'],
        uploadedEvidence: []
      }]
    }));
    const previousGitLab = {
      baseUrl: process.env.MARKIT_GITLAB_BASE_URL,
      auth: process.env.MARKIT_GITLAB_AUTH,
      token: process.env.MARKIT_GITLAB_TOKEN
    };
    gitLabApiRequests.length = 0;
    process.env.MARKIT_GITLAB_BASE_URL = fixtureBaseUrl;
    process.env.MARKIT_GITLAB_AUTH = 'token';
    process.env.MARKIT_GITLAB_TOKEN = 'test-token';
    try {
      const submitResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bugIds: [existingBug.bug.id, newBug.bug.id], assignees: ['songxin', 'qauser'] })
      });
      expect(submitResponse.status).toBe(200);
      const submitBody = await submitResponse.json();
      const reused = submitBody.submissions.find((submission: { bugId: string }) => submission.bugId === existingBug.bug.id);
      const created = submitBody.submissions.find((submission: { bugId: string }) => submission.bugId === newBug.bug.id);
      expect(reused).toMatchObject({ reused: true, synced: true, assignees: ['songxin', 'qauser'], assigneeIds: [501, 502], assigneeResolved: true });
      expect(created).toMatchObject({ assignees: ['songxin', 'qauser'], assigneeIds: [501, 502], assigneeResolved: true });
      const updateRequest = gitLabApiRequests.find((request) => request.method === 'PUT' && request.url.includes('/issues/77'));
      expect(updateRequest).toBeTruthy();
      expect(JSON.parse(updateRequest?.body || '{}').assignee_ids).toEqual([501, 502]);
      const createRequest = gitLabApiRequests.find((request) => request.method === 'POST' && request.url.includes('/issues'));
      expect(JSON.parse(createRequest?.body || '{}').assignee_ids).toEqual([501, 502]);
    } finally {
      restoreEnv('MARKIT_GITLAB_BASE_URL', previousGitLab.baseUrl);
      restoreEnv('MARKIT_GITLAB_AUTH', previousGitLab.auth);
      restoreEnv('MARKIT_GITLAB_TOKEN', previousGitLab.token);
    }
  }, 30_000);

  it('reports unresolved manual assignees without showing them as applied', async () => {
    const item = await createBugForIssueSubmit('部分负责人不存在');
    const previousGitLab = {
      baseUrl: process.env.MARKIT_GITLAB_BASE_URL,
      auth: process.env.MARKIT_GITLAB_AUTH,
      token: process.env.MARKIT_GITLAB_TOKEN
    };
    gitLabApiRequests.length = 0;
    process.env.MARKIT_GITLAB_BASE_URL = fixtureBaseUrl;
    process.env.MARKIT_GITLAB_AUTH = 'token';
    process.env.MARKIT_GITLAB_TOKEN = 'test-token';
    try {
      const submitResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bugIds: [item.bug.id], assignees: ['songxin', 'missinguser'] })
      });
      expect(submitResponse.status).toBe(200);
      const submitBody = await submitResponse.json();
      expect(submitBody.submissions[0]).toMatchObject({
        assignee: 'songxin',
        assignees: ['songxin'],
        assigneeIds: [501],
        unresolvedAssignees: ['missinguser'],
        assigneeResolved: false
      });
      const issueRequest = gitLabApiRequests.find((request) => request.method === 'POST' && request.url.includes('/issues'));
      const issueBody = JSON.parse(issueRequest?.body || '{}');
      expect(issueBody.assignee_ids).toEqual([501]);
      expect(issueBody.description).toContain('Applied Assignees: songxin');
      expect(issueBody.description).toContain('Unresolved Assignees: missinguser');
    } finally {
      restoreEnv('MARKIT_GITLAB_BASE_URL', previousGitLab.baseUrl);
      restoreEnv('MARKIT_GITLAB_AUTH', previousGitLab.auth);
      restoreEnv('MARKIT_GITLAB_TOKEN', previousGitLab.token);
    }
  }, 30_000);

  it('marks new issues with all-invalid manual assignees as applying none', async () => {
    const item = await createBugForIssueSubmit('新 Issue 全部负责人不存在');
    const previousGitLab = {
      baseUrl: process.env.MARKIT_GITLAB_BASE_URL,
      auth: process.env.MARKIT_GITLAB_AUTH,
      token: process.env.MARKIT_GITLAB_TOKEN
    };
    gitLabApiRequests.length = 0;
    process.env.MARKIT_GITLAB_BASE_URL = fixtureBaseUrl;
    process.env.MARKIT_GITLAB_AUTH = 'token';
    process.env.MARKIT_GITLAB_TOKEN = 'test-token';
    try {
      const submitResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bugIds: [item.bug.id], assignees: ['missinguser'] })
      });
      expect(submitResponse.status).toBe(200);
      const submitBody = await submitResponse.json();
      expect(submitBody.submissions[0]).toMatchObject({
        assignee: '',
        assignees: [],
        unresolvedAssignees: ['missinguser'],
        assigneeResolved: false
      });
      expect(submitBody.submissions[0].assigneeIds).toBeUndefined();
      const issueRequest = gitLabApiRequests.find((request) => request.method === 'POST' && request.url.includes('/issues'));
      const issueBody = JSON.parse(issueRequest?.body || '{}');
      expect(issueBody.assignee_ids).toBeUndefined();
      expect(issueBody.description).toContain('Applied Assignees: none');
      expect(issueBody.description).toContain('Unresolved Assignees: missinguser');
    } finally {
      restoreEnv('MARKIT_GITLAB_BASE_URL', previousGitLab.baseUrl);
      restoreEnv('MARKIT_GITLAB_AUTH', previousGitLab.auth);
      restoreEnv('MARKIT_GITLAB_TOKEN', previousGitLab.token);
    }
  }, 30_000);

  it('keeps existing assignee state when manual override resolves no users', async () => {
    const item = await createBugForIssueSubmit('已有 Issue 全部负责人不存在');
    const existingSubmitDir = join(dataDir, 'issue-drafts', 'existing-invalid-assignee');
    await mkdir(existingSubmitDir, { recursive: true });
    await writeFile(join(existingSubmitDir, 'submitted.json'), JSON.stringify({
      schema: 'markit.gitlab-issue-submit.v1',
      submissions: [{
        bugId: item.bug.id,
        title: '[P2] demo.example.com - 已有 Issue 全部负责人不存在',
        projectPath: 'ptc/fe/ptc-wiki',
        iid: 78,
        id: 178,
        webUrl: `${fixtureBaseUrl}/ptc/fe/ptc-wiki/-/issues/78`,
        workItemUrl: `${fixtureBaseUrl}/ptc/fe/ptc-wiki/-/work_items/78`,
        assignee: 'xin',
        assignees: ['xin'],
        assigneeIds: [503],
        assigneeResolved: true,
        labels: ['markit', 'bug'],
        uploadedEvidence: []
      }]
    }));
    const previousGitLab = {
      baseUrl: process.env.MARKIT_GITLAB_BASE_URL,
      auth: process.env.MARKIT_GITLAB_AUTH,
      token: process.env.MARKIT_GITLAB_TOKEN
    };
    gitLabApiRequests.length = 0;
    process.env.MARKIT_GITLAB_BASE_URL = fixtureBaseUrl;
    process.env.MARKIT_GITLAB_AUTH = 'token';
    process.env.MARKIT_GITLAB_TOKEN = 'test-token';
    try {
      const submitResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bugIds: [item.bug.id], assignees: ['missinguser'] })
      });
      expect(submitResponse.status).toBe(200);
      const submitBody = await submitResponse.json();
      expect(submitBody.submissions[0]).toMatchObject({
        reused: true,
        synced: true,
        assignee: 'xin',
        assignees: ['xin'],
        assigneeIds: [503],
        unresolvedAssignees: ['missinguser'],
        assigneeResolved: false
      });
      const updateRequest = gitLabApiRequests.find((request) => request.method === 'PUT' && request.url.includes('/issues/78'));
      expect(updateRequest).toBeTruthy();
      const updateBody = JSON.parse(updateRequest?.body || '{}');
      expect(updateBody.assignee_ids).toBeUndefined();
      expect(updateBody.description).toContain('Applied Assignees: unchanged');
      expect(updateBody.description).toContain('Unresolved Assignees: missinguser');
    } finally {
      restoreEnv('MARKIT_GITLAB_BASE_URL', previousGitLab.baseUrl);
      restoreEnv('MARKIT_GITLAB_AUTH', previousGitLab.auth);
      restoreEnv('MARKIT_GITLAB_TOKEN', previousGitLab.token);
    }
  }, 30_000);

  it('refreshes stale assignee warnings on existing issues', async () => {
    const item = await createBugForIssueSubmit('旧负责人警告应清理');
    const existingSubmitDir = join(dataDir, 'issue-drafts', 'existing-stale-warning');
    await mkdir(existingSubmitDir, { recursive: true });
    await writeFile(join(existingSubmitDir, 'submitted.json'), JSON.stringify({
      schema: 'markit.gitlab-issue-submit.v1',
      submissions: [{
        bugId: item.bug.id,
        title: '[P2] demo.example.com - 旧负责人警告应清理',
        projectPath: 'ptc/fe/ptc-wiki',
        iid: 79,
        id: 179,
        webUrl: `${fixtureBaseUrl}/ptc/fe/ptc-wiki/-/issues/79`,
        workItemUrl: `${fixtureBaseUrl}/ptc/fe/ptc-wiki/-/work_items/79`,
        assignee: 'xin',
        assignees: ['xin'],
        assigneeIds: [503],
        unresolvedAssignees: ['oldmissing'],
        assigneeResolved: false,
        labels: ['markit', 'bug'],
        uploadedEvidence: []
      }]
    }));
    const previousGitLab = {
      baseUrl: process.env.MARKIT_GITLAB_BASE_URL,
      auth: process.env.MARKIT_GITLAB_AUTH,
      token: process.env.MARKIT_GITLAB_TOKEN
    };
    gitLabApiRequests.length = 0;
    process.env.MARKIT_GITLAB_BASE_URL = fixtureBaseUrl;
    process.env.MARKIT_GITLAB_AUTH = 'token';
    process.env.MARKIT_GITLAB_TOKEN = 'test-token';
    try {
      const submitResponse = await fetch(`${apiBaseUrl}/api/bugs/issue-submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bugIds: [item.bug.id], assignees: ['songxin'] })
      });
      expect(submitResponse.status).toBe(200);
      const submitBody = await submitResponse.json();
      expect(submitBody.submissions[0]).toMatchObject({ assignee: 'songxin', assignees: ['songxin'], assigneeIds: [501], assigneeResolved: true });
      expect(submitBody.submissions[0].unresolvedAssignees).toBeUndefined();
      const updateRequest = gitLabApiRequests.find((request) => request.method === 'PUT' && request.url.includes('/issues/79'));
      expect(updateRequest).toBeTruthy();
      const updateBody = JSON.parse(updateRequest?.body || '{}');
      expect(updateBody.assignee_ids).toEqual([501]);
      expect(updateBody.description).not.toContain('Markit Assignment Warning');
      expect(updateBody.description).not.toContain('oldmissing');
    } finally {
      restoreEnv('MARKIT_GITLAB_BASE_URL', previousGitLab.baseUrl);
      restoreEnv('MARKIT_GITLAB_AUTH', previousGitLab.auth);
      restoreEnv('MARKIT_GITLAB_TOKEN', previousGitLab.token);
    }
  }, 30_000);

  it('revives an inactive runtime page before browse actions', async () => {
    const createResponse = await fetch(`${apiBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${fixtureBaseUrl}/index.html`, viewport: { name: 'Desktop 800x500', width: 800, height: 500, deviceScaleFactor: 1 } })
    });
    expect(createResponse.status).toBe(201);
    const created = await createResponse.json();

    await context.runtime.closeSession(created.session.id);
    context.repos.sessions.updateStatus(created.session.id, 'inactive');

    const actionResponse = await fetch(`${apiBaseUrl}/api/sessions/${created.session.id}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'scroll', delta: { x: 0, y: 420 }, baseSessionVersion: created.session.sessionVersion })
    });
    expect(actionResponse.status).toBe(200);
    const action = await actionResponse.json();
    expect(action.session.runtimeStatus).toBe('active');
    expect(action.capture.scroll.y).toBeGreaterThan(0);
  }, 30_000);

  it('rejects unsupported URL schemes at API boundary', async () => {
    const response = await fetch(`${apiBaseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'file:///tmp/test.html' })
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_url_scheme' } });
  });

  it('redacts AI provider secrets while exposing multimodal status', async () => {
    const previous = {
      provider: process.env.MARKIT_AI_PROVIDER,
      baseUrl: process.env.MARKIT_MMF_BASE_URL,
      apiKey: process.env.MARKIT_MMF_API_KEY,
      model: process.env.MARKIT_MMF_MODEL_ID,
      multimodal: process.env.MARKIT_MODEL_MULTIMODAL,
      config: process.env.MARKIT_MMF_CONFIG
    };
    process.env.MARKIT_AI_PROVIDER = 'local-mms-mmf';
    delete process.env.MARKIT_MMF_CONFIG;
    process.env.MARKIT_MMF_BASE_URL = 'http://127.0.0.1:9999/v1';
    process.env.MARKIT_MMF_API_KEY = 'secret-for-test';
    process.env.MARKIT_MMF_MODEL_ID = 'mmf-vision-test';
    process.env.MARKIT_MODEL_MULTIMODAL = 'true';
    try {
      const response = await fetch(`${apiBaseUrl}/api/ai/status`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ enabled: true, provider: 'local-mms-mmf', model: 'mmf-vision-test', supportsImages: true });
      expect(body.apiKey).toBeUndefined();
      expect(body.baseUrl).toBeUndefined();
    } finally {
      restoreEnv('MARKIT_AI_PROVIDER', previous.provider);
      restoreEnv('MARKIT_MMF_BASE_URL', previous.baseUrl);
      restoreEnv('MARKIT_MMF_API_KEY', previous.apiKey);
      restoreEnv('MARKIT_MMF_MODEL_ID', previous.model);
      restoreEnv('MARKIT_MODEL_MULTIMODAL', previous.multimodal);
      restoreEnv('MARKIT_MMF_CONFIG', previous.config);
    }
  });

  it('uses existing bug draft fields when mock-normalizing AI output', async () => {
    const previous = { provider: process.env.MARKIT_AI_PROVIDER };
    process.env.MARKIT_AI_PROVIDER = 'mock';
    try {
      const response = await fetch(`${apiBaseUrl}/api/ai/normalize-bug`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'session_for_ai_test',
          captureId: 'capture_for_ai_test',
          sourceText: '标题：页面403\n期望表现：正常显示',
          currentDraft: {
            title: '页面403',
            actual: '',
            expected: '正常显示',
            severity: 'P2',
            comment: ''
          }
        })
      });
      expect(response.status).toBe(202);
      const body = await response.json();
      expect(body.status).toBe('succeeded');
      expect(body.result.kind).toBe('draft');
      expect(body.result.draft).toMatchObject({
        title: '页面403',
        actual: '页面出现“页面403”，与预期不一致。',
        expected: '正常显示',
        severity: 'P2'
      });
    } finally {
      restoreEnv('MARKIT_AI_PROVIDER', previous.provider);
    }
  });

  it('resolves local MMF from a server config file without exposing endpoint details', async () => {
    const previous = {
      provider: process.env.MARKIT_AI_PROVIDER,
      config: process.env.MARKIT_MMF_CONFIG,
      configKey: process.env.MARKIT_TEST_MMF_KEY,
      baseUrl: process.env.MARKIT_MMF_BASE_URL,
      apiKey: process.env.MARKIT_MMF_API_KEY,
      model: process.env.MARKIT_MMF_MODEL_ID
    };
    const configPath = join(dataDir, 'mmf.config.json');
    await writeFile(configPath, JSON.stringify({
      provider: 'local-mms-mmf',
      baseUrl: 'http://127.0.0.1:9998/v1',
      apiKeyEnv: 'MARKIT_TEST_MMF_KEY',
      modelId: 'mimo-v2.5',
      multimodal: true
    }));
    delete process.env.MARKIT_AI_PROVIDER;
    delete process.env.MARKIT_MMF_BASE_URL;
    delete process.env.MARKIT_MMF_API_KEY;
    delete process.env.MARKIT_MMF_MODEL_ID;
    process.env.MARKIT_MMF_CONFIG = configPath;
    process.env.MARKIT_TEST_MMF_KEY = 'config-secret';
    try {
      const response = await fetch(`${apiBaseUrl}/api/ai/status`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ enabled: true, provider: 'local-mms-mmf', model: 'mimo-v2.5', supportsImages: true, configSource: 'config-file' });
      expect(body.apiKey).toBeUndefined();
      expect(body.baseUrl).toBeUndefined();
    } finally {
      restoreEnv('MARKIT_AI_PROVIDER', previous.provider);
      restoreEnv('MARKIT_MMF_CONFIG', previous.config);
      restoreEnv('MARKIT_TEST_MMF_KEY', previous.configKey);
      restoreEnv('MARKIT_MMF_BASE_URL', previous.baseUrl);
      restoreEnv('MARKIT_MMF_API_KEY', previous.apiKey);
      restoreEnv('MARKIT_MMF_MODEL_ID', previous.model);
    }
  });

  it('auto-discovers a vision-capable local MMS route when MMF env is omitted', async () => {
    const previous = {
      provider: process.env.MARKIT_AI_PROVIDER,
      config: process.env.MARKIT_MMF_CONFIG,
      routePath: process.env.MARKIT_MMS_ROUTES_PATH,
      capabilitiesPath: process.env.MARKIT_MMS_CAPABILITIES_PATH,
      preferred: process.env.MARKIT_MMF_PREFERRED_MODELS,
      baseUrl: process.env.MARKIT_MMF_BASE_URL,
      apiKey: process.env.MARKIT_MMF_API_KEY,
      model: process.env.MARKIT_MMF_MODEL_ID
    };
    const routePath = join(dataDir, 'model-routes.json');
    const capabilitiesPath = join(dataDir, 'model-capabilities.json');
    await writeFile(routePath, JSON.stringify({
      version: 1,
      routes: {
        'mimo-v2.5': {
          primary: {
            provider_id: 'test-provider',
            openai_base_url: 'http://127.0.0.1:9997',
            api_key: 'route-secret',
            model_id: 'mimo-v2.5'
          },
          fallbacks: []
        }
      }
    }));
    await writeFile(capabilitiesPath, JSON.stringify({
      models: [{ alias: 'mimo-v2.5', canonical_model_id: 'mimo-v2.5', supports_vision: true }]
    }));
    delete process.env.MARKIT_AI_PROVIDER;
    delete process.env.MARKIT_MMF_CONFIG;
    delete process.env.MARKIT_MMF_BASE_URL;
    delete process.env.MARKIT_MMF_API_KEY;
    delete process.env.MARKIT_MMF_MODEL_ID;
    process.env.MARKIT_MMS_ROUTES_PATH = routePath;
    process.env.MARKIT_MMS_CAPABILITIES_PATH = capabilitiesPath;
    process.env.MARKIT_MMF_PREFERRED_MODELS = 'mimo-v2.5';
    try {
      const response = await fetch(`${apiBaseUrl}/api/ai/status`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ enabled: true, provider: 'local-mms-mmf', model: 'mimo-v2.5', supportsImages: true, configSource: 'mms-auto' });
      expect(body.apiKey).toBeUndefined();
      expect(body.baseUrl).toBeUndefined();
    } finally {
      restoreEnv('MARKIT_AI_PROVIDER', previous.provider);
      restoreEnv('MARKIT_MMF_CONFIG', previous.config);
      restoreEnv('MARKIT_MMS_ROUTES_PATH', previous.routePath);
      restoreEnv('MARKIT_MMS_CAPABILITIES_PATH', previous.capabilitiesPath);
      restoreEnv('MARKIT_MMF_PREFERRED_MODELS', previous.preferred);
      restoreEnv('MARKIT_MMF_BASE_URL', previous.baseUrl);
      restoreEnv('MARKIT_MMF_API_KEY', previous.apiKey);
      restoreEnv('MARKIT_MMF_MODEL_ID', previous.model);
    }
  });
});

async function createBugForIssueSubmit(title: string) {
  const createResponse = await fetch(`${apiBaseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: `${fixtureBaseUrl}/index.html`,
      viewport: { name: 'Desktop 800x500', width: 800, height: 500, deviceScaleFactor: 1 },
      projectSnapshot
    })
  });
  expect(createResponse.status).toBe(201);
  const created = await createResponse.json();
  const bugResponse = await fetch(`${apiBaseUrl}/api/bugs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId: created.session.id,
      title,
      actual: '负责人同步测试。',
      expected: 'GitLab assignee_ids 应符合本次选择。',
      severity: 'P2',
      status: 'draft',
      sourceUrl: created.session.sourceUrl,
      finalUrl: created.capture.finalUrl,
      primaryCaptureId: created.capture.id
    })
  });
  expect(bugResponse.status).toBe(201);
  return { session: created, bug: (await bugResponse.json()).bug };
}

async function handleGitLabFixture(req: IncomingMessage, res: ServerResponse) {
  const body = await readRequestBody(req);
  gitLabApiRequests.push({ method: req.method ?? 'GET', url: req.url ?? '', body });
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET' && req.url === '/api/v4/user') {
    res.end(JSON.stringify({ id: 501, username: 'songxin', name: '宋鑫' }));
    return;
  }
  if (req.method === 'GET' && req.url?.startsWith('/api/v4/users?')) {
    const username = new URL(req.url, fixtureBaseUrl).searchParams.get('username') ?? '';
    const users: Record<string, { id: number; username: string; name: string }> = {
      songxin: { id: 501, username: 'songxin', name: '宋鑫' },
      qauser: { id: 502, username: 'qauser', name: 'QA User' },
      xin: { id: 503, username: 'xin', name: 'Xin' }
    };
    res.end(JSON.stringify(users[username] ? [users[username]] : []));
    return;
  }
  const issueMatch = req.url?.match(/\/issues\/(\d+)/);
  if (req.method === 'GET' && issueMatch) {
    const iid = Number(issueMatch[1]);
    const description = iid === 79
      ? 'Existing issue body\n\n## Markit Assignment Warning\n\n- Applied Assignees: xin\n- Unresolved Assignees: oldmissing\n'
      : 'Existing issue body';
    res.end(JSON.stringify({ id: 1000 + iid, iid, web_url: `${fixtureBaseUrl}/ptc/fe/ptc-wiki/-/work_items/${iid}`, description }));
    return;
  }
  if (req.method === 'PUT' && issueMatch) {
    const iid = Number(issueMatch[1]);
    res.end(JSON.stringify({ id: 1000 + iid, iid, web_url: `${fixtureBaseUrl}/ptc/fe/ptc-wiki/-/work_items/${iid}` }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/uploads')) {
    res.end(JSON.stringify({
      markdown: '![screenshot](/uploads/mock/screenshot.png)',
      url: '/uploads/mock/screenshot.png',
      full_path: '/-/project/816/uploads/mock/screenshot.png'
    }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/issues')) {
    res.end(JSON.stringify({ id: 1001, iid: 101, web_url: `${fixtureBaseUrl}/ptc/fe/ptc-wiki/-/work_items/101` }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ message: 'not found' }));
}

async function handleFeishuFixture(req: IncomingMessage, res: ServerResponse) {
  const body = await readRequestBody(req);
  feishuApiRequests.push({ method: req.method ?? 'GET', url: req.url ?? '', body, authorization: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  if (req.method === 'POST' && req.url?.includes('/records')) {
    res.end(JSON.stringify({ code: 0, msg: 'success', data: { record: { record_id: 'rec_markit_sync' } } }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/medias/upload_all')) {
    res.end(JSON.stringify({ code: 0, msg: 'success', data: { file_token: 'file_markit_sync' } }));
    return;
  }
  if (req.method === 'POST' && req.url?.includes('/append_attachments')) {
    res.end(JSON.stringify({ code: 0, msg: 'success', data: {} }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ code: 404, msg: 'not found' }));
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
  });
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
