import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router } from 'express';
import type { ServerContext } from '../context.js';
import { all, asyncHandler, first, nowIso, parseJson } from './helpers.js';
import { MarkitHttpError } from '../url-safety.js';

export function aiRouter(context: ServerContext): Router {
  const router = Router();

  router.get('/api/ai/status', (_req, res) => {
    const status = resolveProvider();
    res.json(status);
  });

  router.post('/api/ai/normalize-bug', asyncHandler(async (req, res) => {
    const status = resolveProvider();
    if (!status.enabled) throw new MarkitHttpError(409, 'ai_provider_disabled', status.reason || 'AI provider disabled');
    const jobId = `ai_${randomUUID()}`;
    const ts = nowIso();
    context.database.db.run(
      `INSERT INTO ai_jobs (id, session_id, bug_id, capture_id, status, request_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [jobId, String(req.body?.sessionId), req.body?.bugId ? String(req.body.bugId) : null, String(req.body?.captureId), 'running', JSON.stringify(req.body), ts, ts]
    );
    const result = status.provider === 'mock'
      ? mockNormalize(req.body)
      : await openAiCompatibleNormalize(req.body, status);
    const nextStatus = result.kind === 'clarification_required' ? 'clarification_required' : 'succeeded';
    context.database.db.run('UPDATE ai_jobs SET status = ?, response_json = ?, updated_at = ? WHERE id = ?', [nextStatus, JSON.stringify(result), nowIso(), jobId]);
    const tracePath = join(context.dataDir, 'ai-runs', `${jobId}.json`);
    await mkdir(join(context.dataDir, 'ai-runs'), { recursive: true });
    await writeFile(tracePath, JSON.stringify({ request: req.body, response: result, provider: status.provider, model: status.model || 'mock' }, null, 2));
    context.database.db.run(
      `INSERT INTO ai_runs (id, job_id, provider, model, trace_path, latency_ms, schema_valid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [`run_${randomUUID()}`, jobId, status.provider, status.model || 'mock', tracePath, 0, 1, nowIso()]
    );
    await context.database.save();
    res.status(202).json({ jobId, status: nextStatus, result });
  }));

  router.get('/api/ai/jobs/:jobId', (req, res) => {
    const row = first(context.database.db, 'SELECT * FROM ai_jobs WHERE id = ?', [String(req.params.jobId)]);
    if (!row) throw new MarkitHttpError(404, 'ai_job_not_found', 'AI job not found');
    res.json({
      job: {
        id: String(row.id),
        status: String(row.status),
        result: parseJson(row.response_json, undefined),
        error: parseJson(row.error_json, undefined),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at)
      }
    });
  });

  router.post('/api/ai/jobs/:jobId/cancel', asyncHandler(async (req, res) => {
    context.database.db.run('UPDATE ai_jobs SET status = ?, updated_at = ? WHERE id = ?', ['cancelled', nowIso(), String(req.params.jobId)]);
    await context.database.save();
    res.json({ ok: true });
  }));

  return router;
}

type ProviderStatus = { enabled: boolean; provider: 'off' | 'mock' | 'openai-compatible' | 'local-mms-mmf'; model?: string; baseUrl?: string; apiKey?: string; reason?: string };

function resolveProvider(): ProviderStatus {
  const provider = (process.env.MARKIT_AI_PROVIDER || 'off') as ProviderStatus['provider'];
  if (provider === 'mock') return { enabled: true, provider: 'mock', model: 'mock' };
  if (provider === 'openai-compatible') {
    if (!process.env.MARKIT_MODEL_BASE_URL || !process.env.MARKIT_MODEL_API_KEY || !process.env.MARKIT_MODEL_ID) {
      return { enabled: false, provider, reason: 'Missing MARKIT_MODEL_BASE_URL, MARKIT_MODEL_API_KEY, or MARKIT_MODEL_ID' };
    }
    return { enabled: true, provider, baseUrl: process.env.MARKIT_MODEL_BASE_URL, apiKey: process.env.MARKIT_MODEL_API_KEY, model: process.env.MARKIT_MODEL_ID };
  }
  if (provider === 'local-mms-mmf') {
    return { enabled: false, provider, reason: 'local-mms-mmf adapter is reserved until route file wiring is enabled' };
  }
  return { enabled: false, provider: 'off', reason: 'AI normalizer is disabled' };
}

function mockNormalize(input: Record<string, unknown>) {
  const text = String(input?.sourceText || '');
  const hasExpected = /应该|期望|expected|should|需要|改成/i.test(text);
  if (!hasExpected) {
    return {
      kind: 'clarification_required' as const,
      questions: [{ id: 'q_expected', question: '这个问题的期望表现是什么？', reason: 'missing_expected' as const, suggestions: ['与设计稿一致', '完整显示关键按钮', '保持当前布局但修复遮挡'] }],
      partialDraft: {
        title: text.slice(0, 32) || '未命名问题',
        actual: text,
        affectedArea: '当前标注区域'
      },
      modelTraceId: `mock_${randomUUID()}`,
      unresolvedFields: ['expected']
    };
  }
  return {
    kind: 'draft' as const,
    draft: {
      title: inferTitle(text),
      problemType: inferProblemType(text),
      severity: inferSeverity(text),
      actual: text,
      expected: extractExpected(text),
      affectedArea: '当前标注区域',
      reproSteps: ['打开目标 URL', '切换到当前 viewport', '查看标注区域'],
      acceptanceCriteria: ['标注区域的问题已修复', '在当前 viewport 下重新截图无明显视觉错误'],
      openQuestions: [],
      confidence: 0.99,
      fieldConfidence: {
        title: 0.99,
        problemType: 0.99,
        severity: 0.99,
        actual: 0.99,
        expected: 0.99,
        affectedArea: 0.99,
        reproSteps: 0.99,
        acceptanceCriteria: 0.99
      }
    },
    modelTraceId: `mock_${randomUUID()}`,
    unresolvedFields: []
  };
}

async function openAiCompatibleNormalize(input: Record<string, unknown>, status: ProviderStatus) {
  const response = await fetch(`${status.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${status.apiKey}` },
    body: JSON.stringify({
      model: status.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You convert UI bug comments into strict JSON. Return either draft or clarification_required.' },
        { role: 'user', content: JSON.stringify(input) }
      ]
    })
  });
  if (!response.ok) throw new MarkitHttpError(502, 'ai_provider_failed', `Provider failed: ${response.status}`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  try {
    return JSON.parse(body.choices?.[0]?.message?.content || '{}');
  } catch {
    throw new MarkitHttpError(502, 'ai_response_invalid', 'Model did not return valid JSON');
  }
}

function inferTitle(text: string): string {
  return text.replace(/[。.!].*$/, '').slice(0, 48) || 'UI 问题';
}

function inferProblemType(text: string) {
  if (/点击|按钮|交互|无法|打不开/.test(text)) return 'interaction';
  if (/文案|错别字|copy/i.test(text)) return 'copy';
  if (/数据|数值|百分比/.test(text)) return 'data';
  if (/间距|换行|遮挡|布局|对齐/.test(text)) return 'layout';
  return 'visual';
}

function inferSeverity(text: string) {
  if (/P0|崩溃|无法使用|关键/.test(text)) return 'P0';
  if (/P1|遮挡|无法点击|严重/.test(text)) return 'P1';
  if (/P3|轻微|文案/.test(text)) return 'P3';
  return 'P2';
}

function extractExpected(text: string): string {
  const match = text.match(/(?:应该|期望|should|expected|需要)(.*)$/i);
  return match?.[1]?.trim() || '应按设计预期正确显示并可操作。';
}
