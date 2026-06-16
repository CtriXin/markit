import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Router } from 'express';
import type { ServerContext } from '../context.js';
import { all, asyncHandler, first, nowIso, parseJson } from './helpers.js';
import { MarkitHttpError } from '../url-safety.js';

export function aiRouter(context: ServerContext): Router {
  const router = Router();

  router.get('/api/ai/status', (_req, res) => {
    const status = resolveProvider();
    const { apiKey: _apiKey, baseUrl: _baseUrl, ...publicStatus } = status;
    res.json(publicStatus);
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

type ProviderStatus = { enabled: boolean; provider: 'off' | 'mock' | 'openai-compatible' | 'local-mms-mmf'; model?: string; baseUrl?: string; apiKey?: string; supportsImages?: boolean; configSource?: string; reason?: string };
type MmfConfig = {
  provider?: 'local-mms-mmf';
  baseUrl?: string;
  openaiBaseUrl?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  modelId?: string;
  model?: string;
  multimodal?: boolean;
  routeFile?: string;
  capabilitiesFile?: string;
  preferredModels?: string[];
};
type MmsRouteMatch = { baseUrl: string; apiKey: string; model: string; supportsImages: boolean; source: string };

function resolveProvider(): ProviderStatus {
  const mmfConfig = loadMmfConfig();
  const provider = (process.env.MARKIT_AI_PROVIDER || mmfConfig?.provider || (hasLocalMmsRoutes(mmfConfig) ? 'local-mms-mmf' : 'off')) as ProviderStatus['provider'];
  if (provider === 'mock') return { enabled: true, provider: 'mock', model: 'mock' };
  if (provider === 'openai-compatible') {
    if (!process.env.MARKIT_MODEL_BASE_URL || !process.env.MARKIT_MODEL_API_KEY || !process.env.MARKIT_MODEL_ID) {
      return { enabled: false, provider, reason: 'Missing MARKIT_MODEL_BASE_URL, MARKIT_MODEL_API_KEY, or MARKIT_MODEL_ID' };
    }
    return { enabled: true, provider, baseUrl: process.env.MARKIT_MODEL_BASE_URL, apiKey: process.env.MARKIT_MODEL_API_KEY, model: process.env.MARKIT_MODEL_ID, supportsImages: truthy(process.env.MARKIT_MODEL_MULTIMODAL), configSource: 'env' };
  }
  if (provider === 'local-mms-mmf') {
    const envModel = process.env.MARKIT_MMF_MODEL_ID || process.env.MARKIT_MODEL_ID;
    const configuredBaseUrl = process.env.MARKIT_MMF_BASE_URL || process.env.MARKIT_MODEL_BASE_URL || process.env.OPENAI_BASE_URL || mmfConfig?.baseUrl || mmfConfig?.openaiBaseUrl;
    const configuredApiKey = process.env.MARKIT_MMF_API_KEY || process.env.MARKIT_MODEL_API_KEY || process.env.OPENAI_API_KEY || apiKeyFromConfig(mmfConfig);
    const configuredModel = envModel || mmfConfig?.modelId || mmfConfig?.model;
    const route = !configuredBaseUrl || !configuredApiKey || !configuredModel ? loadMmsRoute(configuredModel, mmfConfig) : undefined;
    const baseUrl = configuredBaseUrl || route?.baseUrl;
    const apiKey = configuredApiKey || route?.apiKey;
    const model = configuredModel || route?.model;
    if (!baseUrl || !apiKey || !model) return { enabled: false, provider, reason: 'Missing MARKIT_MMF_BASE_URL, MARKIT_MMF_API_KEY, or MARKIT_MMF_MODEL_ID' };
    return {
      enabled: true,
      provider,
      baseUrl,
      apiKey,
      model,
      supportsImages: process.env.MARKIT_MODEL_MULTIMODAL === undefined ? mmfConfig?.multimodal ?? route?.supportsImages ?? true : process.env.MARKIT_MODEL_MULTIMODAL !== 'false',
      configSource: route?.source ?? (mmfConfig ? 'config-file' : 'env')
    };
  }
  return { enabled: false, provider: 'off', reason: 'AI normalizer is disabled' };
}

function truthy(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

function loadMmfConfig(): MmfConfig | undefined {
  const explicit = process.env.MARKIT_MMF_CONFIG;
  const candidates = [
    explicit,
    join(process.cwd(), '.markit', 'mmf.config.json'),
    resolve(process.cwd(), '..', '..', '.markit', 'mmf.config.json')
  ].filter((path): path is string => Boolean(path));
  const configPath = candidates.find((path) => existsSync(path));
  if (!configPath) return undefined;
  try {
    return normalizeMmfConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch {
    return undefined;
  }
}

function normalizeMmfConfig(value: unknown): MmfConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  const config: MmfConfig = {};
  if (input.provider === 'local-mms-mmf') config.provider = 'local-mms-mmf';
  for (const [from, to] of [
    ['baseUrl', 'baseUrl'],
    ['openaiBaseUrl', 'openaiBaseUrl'],
    ['apiKey', 'apiKey'],
    ['apiKeyEnv', 'apiKeyEnv'],
    ['modelId', 'modelId'],
    ['model', 'model'],
    ['routeFile', 'routeFile'],
    ['capabilitiesFile', 'capabilitiesFile']
  ] as const) {
    if (typeof input[from] === 'string' && input[from].trim()) config[to] = input[from].trim();
  }
  if (typeof input.multimodal === 'boolean') config.multimodal = input.multimodal;
  if (Array.isArray(input.preferredModels)) config.preferredModels = input.preferredModels.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
  return config;
}

function apiKeyFromConfig(config: MmfConfig | undefined): string | undefined {
  if (!config) return undefined;
  if (config.apiKey) return config.apiKey;
  if (config.apiKeyEnv) return process.env[config.apiKeyEnv];
  return undefined;
}

function hasLocalMmsRoutes(config: MmfConfig | undefined): boolean {
  return existsSync(routeFilePath(config));
}

function routeFilePath(config: MmfConfig | undefined): string {
  return config?.routeFile || process.env.MARKIT_MMS_ROUTES_PATH || join(homedir(), '.config', 'mms', 'generated', 'model-routes.json');
}

function capabilitiesFilePath(config: MmfConfig | undefined): string {
  return config?.capabilitiesFile || process.env.MARKIT_MMS_CAPABILITIES_PATH || join(homedir(), '.config', 'mms', 'generated', 'model-capabilities.approved.json');
}

function loadMmsRoute(requestedModel: string | undefined, config: MmfConfig | undefined): MmsRouteMatch | undefined {
  const path = routeFilePath(config);
  if (!existsSync(path)) return undefined;
  try {
    const routes = JSON.parse(readFileSync(path, 'utf8'))?.routes;
    if (!routes || typeof routes !== 'object') return undefined;
    const visionModels = loadVisionModelSet(config);
    const preferred = preferredModels(requestedModel, config);
    const keys = Object.keys(routes as Record<string, unknown>);
    const orderedKeys = [...preferred, ...keys].filter((value, index, list) => value && list.indexOf(value) === index);
    for (const candidate of orderedKeys) {
      const entry = findRouteEntry(routes as Record<string, unknown>, candidate);
      if (!entry) continue;
      const primary = typeof entry.route === 'object' ? (entry.route as Record<string, unknown>).primary : undefined;
      if (!primary || typeof primary !== 'object') continue;
      const row = primary as Record<string, unknown>;
      const model = String(row.model_id || entry.key || candidate);
      const supportsImages = visionModels.size ? visionModels.has(candidate) || visionModels.has(model) || visionModels.has(entry.key) : true;
      if (!requestedModel && !supportsImages) continue;
      const baseUrl = typeof row.openai_base_url === 'string' ? row.openai_base_url : typeof row.base_url === 'string' ? row.base_url : '';
      const apiKey = typeof row.api_key === 'string' ? row.api_key : '';
      if (baseUrl && apiKey && model) return { baseUrl, apiKey, model, supportsImages, source: requestedModel ? 'mms-route' : 'mms-auto' };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function preferredModels(requestedModel: string | undefined, config: MmfConfig | undefined): string[] {
  if (requestedModel) return [requestedModel];
  const envPreferred = process.env.MARKIT_MMF_PREFERRED_MODELS?.split(',').map((item) => item.trim()).filter(Boolean);
  return envPreferred?.length ? envPreferred : config?.preferredModels?.length ? config.preferredModels : ['mimo-v2.5', 'qwen3.6-plus', 'qwen3.5-plus', 'MiniMax-M2.7', 'gpt-5.4-mini', 'gpt-5.4'];
}

function findRouteEntry(routes: Record<string, unknown>, candidate: string): { key: string; route: unknown } | undefined {
  if (routes[candidate]) return { key: candidate, route: routes[candidate] };
  return Object.entries(routes).map(([key, route]) => ({ key, route })).find(({ key, route }) => {
    const primary = route && typeof route === 'object' ? (route as Record<string, unknown>).primary : undefined;
    return key === candidate || (primary && typeof primary === 'object' && String((primary as Record<string, unknown>).model_id || '') === candidate);
  });
}

function loadVisionModelSet(config: MmfConfig | undefined): Set<string> {
  const path = capabilitiesFilePath(config);
  if (!existsSync(path)) return new Set();
  try {
    const models = JSON.parse(readFileSync(path, 'utf8'))?.models;
    if (!Array.isArray(models)) return new Set();
    return new Set(models
      .filter((model) => model && typeof model === 'object' && (model as Record<string, unknown>).supports_vision === true)
      .flatMap((model) => [String((model as Record<string, unknown>).alias || ''), String((model as Record<string, unknown>).canonical_model_id || '')])
      .filter(Boolean));
  } catch {
    return new Set();
  }
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
  const response = await fetch(chatCompletionsEndpoint(status.baseUrl!), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${status.apiKey}` },
    body: JSON.stringify({
      model: status.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: buildNormalizeMessages(input, status)
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

function chatCompletionsEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/$/, '');
  return /\/v\d+$/i.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

function buildNormalizeMessages(input: Record<string, unknown>, status: ProviderStatus) {
  const system = { role: 'system', content: 'You convert UI bug comments and optional screenshots into strict JSON. Return either draft or clarification_required. If screenshots are provided, use them as original evidence and mention visible mismatch only when directly supported.' };
  const text = JSON.stringify({ ...input, assets: imageAssetSummary(input.assets) });
  if (!status.supportsImages) return [system, { role: 'user', content: text }];
  const imageParts = imageAssets(input.assets).slice(0, 4).map((asset) => ({ type: 'image_url', image_url: { url: asset.dataUrl } }));
  if (!imageParts.length) return [system, { role: 'user', content: text }];
  return [
    system,
    {
      role: 'user',
      content: [
        { type: 'text', text },
        ...imageParts
      ]
    }
  ];
}

function imageAssets(value: unknown): Array<{ fileName: string; mimeType: string; label: string; dataUrl: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item && typeof item === 'object' ? item : {}) as Record<string, unknown>)
    .filter((item) => typeof item.dataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,/i.test(item.dataUrl))
    .map((item) => ({
      fileName: String(item.fileName ?? 'screenshot.png'),
      mimeType: String(item.mimeType ?? 'image/png'),
      label: String(item.label ?? '截图证据'),
      dataUrl: String(item.dataUrl)
    }));
}

function imageAssetSummary(value: unknown) {
  return imageAssets(value).map(({ dataUrl: _dataUrl, ...asset }) => asset);
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
