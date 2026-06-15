import { Router } from 'express';
import type { ServerContext } from '../context.js';
import { asyncHandler } from './helpers.js';

const defaultSettings = {
  browser: {
    defaultViewport: 'Mobile 390x844',
    navigationTimeoutMs: 30000,
    captureDefault: 'viewport',
    fullPageMaxHeight: 12000,
    deviceScaleFactor: 1,
    autoRecaptureAfterBrowseAction: true
  },
  ai: {
    provider: process.env.MARKIT_AI_PROVIDER || 'off',
    clarificationThreshold: 0.98,
    sendScreenshotCropToModel: false
  }
};

export function settingsRouter(context: ServerContext): Router {
  const router = Router();
  router.get('/api/settings', (_req, res) => {
    res.json({ settings: context.repos.settings.get('app.settings') ?? defaultSettings });
  });
  router.patch('/api/settings', asyncHandler(async (req, res) => {
    const next = { ...defaultSettings, ...(req.body?.settings ?? req.body ?? {}) };
    context.repos.settings.set('app.settings', next);
    await context.database.save();
    res.json({ settings: next });
  }));
  return router;
}
