import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import { createApp } from '../src/app.js';

let dataDir: string;
let server: Server;
let baseUrl: string;

function listen(app: Express): Promise<{ server: Server; baseUrl: string }> {
  return new Promise((resolveListen) => {
    const serverToStart = app.listen(0, '127.0.0.1', () => {
      const address = serverToStart.address();
      if (!address || typeof address === 'string') throw new Error('Missing server address');
      resolveListen({ server: serverToStart, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function close(serverToClose: Server): Promise<void> {
  return new Promise((resolveClose, reject) => serverToClose.close((error) => (error ? reject(error) : resolveClose())));
}

describe('project catalog API', () => {
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'markit-catalog-'));
    await writeFixtureCatalog(dataDir);
    const started = await listen(createApp(undefined, { catalogRoot: dataDir }));
    server = started.server;
    baseUrl = started.baseUrl;
  });

  afterAll(async () => {
    await close(server);
    await rm(dataDir, { recursive: true, force: true });
  });

  it('exposes catalog status, searchable projects, project domains, and URL resolution', async () => {
    const status = await fetch(`${baseUrl}/api/catalog/status`).then((response) => response.json());
    expect(status).toMatchObject({ enabled: true, projectCount: 2, domainCount: 1, sync: { status: 'skipped', reason: 'not_git_worktree' } });

    const projects = await fetch(`${baseUrl}/api/catalog/projects?query=demo`).then((response) => response.json());
    expect(projects.projects).toHaveLength(1);
    expect(projects.projects[0]).toMatchObject({
      id: 'demo-project',
      name: 'Demo Project',
      scmpService: 'ptc-demo',
      localFolderHint: 'ptc-demo-folder',
      activeBranch: 'release-1.2.3',
      domainCount: 1
    });
    expect(projects.projects.some((project: { id: string }) => project.id === 'empty-project')).toBe(false);

    const domains = await fetch(`${baseUrl}/api/catalog/domains?projectId=demo-project`).then((response) => response.json());
    expect(domains.domains).toEqual([
      expect.objectContaining({ host: 'demo.example.com', projectId: 'demo-project', status: 'active', defaultAssignee: 'domain-owner', defaultAssignees: ['domain-owner'] })
    ]);

    const resolved = await fetch(`${baseUrl}/api/catalog/resolve?url=${encodeURIComponent('https://DEMO.example.com/path?x=1')}`).then((response) => response.json());
    expect(resolved).toMatchObject({
      matched: true,
      hostname: 'demo.example.com',
      matchedHost: 'demo.example.com',
      project: { id: 'demo-project', name: 'Demo Project', localFolderHint: 'ptc-demo-folder' },
      domain: { host: 'demo.example.com', env: 'prod', defaultAssignee: 'domain-owner', defaultAssignees: ['domain-owner'] }
    });
  });

  it('fails open when the catalog root is absent', async () => {
    const missingRoot = join(dataDir, 'missing');
    const missing = await listen(createApp(undefined, { catalogRoot: missingRoot }));
    const missingServer = missing.server;
    const missingBaseUrl = missing.baseUrl;
    try {
      const status = await fetch(`${missingBaseUrl}/api/catalog/status`).then((response) => response.json());
      expect(status).toMatchObject({ enabled: false, reason: 'catalog_root_missing' });

      const projects = await fetch(`${missingBaseUrl}/api/catalog/projects`).then((response) => response.json());
      expect(projects.projects).toEqual([]);
    } finally {
      await close(missingServer);
    }
  });
});

async function writeFixtureCatalog(root: string) {
  await mkdir(join(root, 'integrations'), { recursive: true });
  await mkdir(join(root, 'catalog', 'projects'), { recursive: true });
  await writeFile(join(root, 'integrations', 'markit.json'), JSON.stringify({
    schema: 'markit.catalog.binding.v1',
    consumer: { id: 'markit', repo: 'git@example.com:markit.git' },
    catalog: {
      manifest: 'catalog/catalog.manifest.json',
      domainIndex: 'catalog/domains.json',
      projectsGlob: 'catalog/projects/*.json'
    },
    workflow: { syncPolicy: 'git pull --ff-only before test' }
  }));
  await writeFile(join(root, 'catalog', 'catalog.manifest.json'), JSON.stringify({
    schema: 'ptc.catalog.v1',
    generatedAt: '2026-06-17T00:00:00.000Z',
    projectCount: 2,
    domainCount: 1,
    projects: ['projects/demo-project.json', 'projects/empty-project.json'],
    domainIndex: 'domains.json',
    source: { kind: 'fixture', generatedAt: '2026-06-17T00:00:00.000Z', pendingAssociations: 0 }
  }));
  await writeFile(join(root, 'catalog', 'domains.json'), JSON.stringify({
    schema: 'ptc.domain-index.v1',
    generatedAt: '2026-06-17T00:00:00.000Z',
    domains: {
      'demo.example.com': {
        projectId: 'demo-project',
        projectName: 'Demo Project',
        scmpService: 'ptc-demo',
        gitlabPath: 'ptc/fe/demo',
        activeBranch: 'release-1.2.3',
        defaultAssignee: 'domain-owner',
        env: 'prod',
        status: 'active'
      }
    }
  }));
  await writeFile(join(root, 'catalog', 'projects', 'demo-project.json'), JSON.stringify({
    schema: 'ptc.project.v1',
    id: 'demo-project',
    name: 'Demo Project',
    aliases: ['demo'],
    status: 'active',
    scmp: { service: 'ptc-demo' },
    repo: { gitlabPath: 'ptc/fe/demo', localFolderHint: 'ptc-demo-folder', activeBranch: 'release-1.2.3' },
    domains: [{ host: 'demo.example.com', env: 'prod', status: 'active' }],
    gitlab: { issueProjectPath: 'ptc/fe/demo', defaultAssignee: 'xin', defaultAssignees: ['project-dev', 'project-qa'], labels: ['markit', 'bug'] },
    testing: { enabled: true, defaultViewport: 'desktop-1440', viewports: ['desktop-1440', 'mobile-390'] },
    owners: { qa: ['xin'], dev: ['dev1'] },
    sources: [{ kind: 'fixture', path: 'fixture' }],
    confidence: 0.99
  }));
  await writeFile(join(root, 'catalog', 'projects', 'empty-project.json'), JSON.stringify({
    schema: 'ptc.project.v1',
    id: 'empty-project',
    name: 'Empty Project',
    aliases: ['demo empty'],
    status: 'active',
    repo: { gitlabPath: 'ptc/fe/empty', activeBranch: 'main' },
    domains: [],
    gitlab: { issueProjectPath: 'ptc/fe/empty', labels: ['markit', 'bug'] },
    testing: { enabled: true, defaultViewport: 'desktop-1440', viewports: ['desktop-1440'] },
    confidence: 0.2
  }));
}
