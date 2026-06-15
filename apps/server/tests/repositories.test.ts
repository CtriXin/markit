import { describe, expect, it } from 'vitest';
import { applyMigrations, createMemoryDatabase } from '../src/db/migrations.js';
import { createRepositories } from '../src/db/repositories.js';

const viewport = { name: 'Mobile 390x844', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true };
const geometry = {
  pageRect: { x: 1, y: 2, width: 3, height: 4 },
  captureRect: { x: 1, y: 2, width: 3, height: 4 },
  viewportRect: { x: 1, y: 2, width: 3, height: 4 }
};

async function seededRepos() {
  const db = await createMemoryDatabase();
  applyMigrations(db);
  const repos = createRepositories(db);
  repos.sessions.insert({
    id: 'ses_1',
    sourceUrl: 'https://example.com',
    currentUrl: 'https://example.com',
    viewport,
    runtimeStatus: 'active'
  });
  repos.captures.insert({
    id: 'cap_1',
    sessionId: 'ses_1',
    sessionVersion: 0,
    url: 'https://example.com',
    finalUrl: 'https://example.com',
    viewport,
    scrollX: 0,
    scrollY: 0,
    mode: 'viewport',
    screenshotPath: '.markit/captures/cap_1/screenshot.png',
    domTargetsPath: '.markit/captures/cap_1/dom-targets.json',
    imageWidth: 390,
    imageHeight: 844
  });
  return repos;
}

describe('repositories', () => {
  it('stores settings JSON', async () => {
    const repos = await seededRepos();
    repos.settings.set('browser.defaultViewport', viewport);
    expect(repos.settings.get('browser.defaultViewport')).toEqual(viewport);
  });

  it('stores sessions and captures', async () => {
    const repos = await seededRepos();
    expect(repos.sessions.get('ses_1')?.runtime_status).toBe('active');
    repos.sessions.updateStatus('ses_1', 'inactive');
    expect(repos.sessions.get('ses_1')?.runtime_status).toBe('inactive');
    expect(repos.captures.listBySession('ses_1')).toHaveLength(1);
  });

  it('stores annotations, bugs, and relations without duplicating ownership', async () => {
    const repos = await seededRepos();
    repos.annotations.insert({ id: 'ann_1', captureId: 'cap_1', kind: 'rect', geometry, note: 'clipped', colorRole: 'bug' });
    repos.bugs.insert({
      id: 'bug_1',
      sessionId: 'ses_1',
      title: 'Button clipped',
      actual: 'clipped',
      expected: 'visible',
      severity: 'P1',
      status: 'draft',
      sourceUrl: 'https://example.com',
      finalUrl: 'https://example.com',
      primaryCaptureId: 'cap_1'
    });
    repos.bugAnnotations.add('bug_1', 'ann_1', 0);
    expect(repos.bugAnnotations.listForBug('bug_1')).toHaveLength(1);
    repos.bugAnnotations.remove('bug_1', 'ann_1');
    expect(repos.bugAnnotations.listForBug('bug_1')).toHaveLength(0);
    expect(repos.annotations.get('ann_1')?.id).toBe('ann_1');
  });

  it('stores AI jobs and runs', async () => {
    const repos = await seededRepos();
    repos.aiJobs.insert({ id: 'job_1', sessionId: 'ses_1', captureId: 'cap_1', status: 'queued', request: { sourceText: 'button wrong' } });
    repos.aiJobs.updateStatus('job_1', 'succeeded', { kind: 'draft' });
    repos.aiRuns.insert({ id: 'run_1', jobId: 'job_1', provider: 'mock', model: 'mock', tracePath: '.markit/ai-runs/ai_1.json', schemaValid: true });
    expect(repos.aiJobs.get('job_1')?.status).toBe('succeeded');
    expect(repos.aiRuns.listForJob('job_1')).toHaveLength(1);
  });
});
