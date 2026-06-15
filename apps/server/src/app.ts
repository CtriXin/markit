import express, { type ErrorRequestHandler } from 'express';
import type { ServerContext } from './context.js';
import { sessionsRouter } from './routes/sessions.js';
import { annotationsRouter } from './routes/annotations.js';
import { bugsRouter } from './routes/bugs.js';
import { aiRouter } from './routes/ai.js';
import { settingsRouter } from './routes/settings.js';
import { MarkitHttpError } from './url-safety.js';

export type HealthResponse = {
  ok: true;
  name: 'markit-server';
  version: string;
  time: string;
};

export function createApp(context?: ServerContext) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    const body: HealthResponse = {
      ok: true,
      name: 'markit-server',
      version: '0.1.0',
      time: new Date().toISOString()
    };
    res.json(body);
  });

  if (context) {
    app.use(sessionsRouter(context));
    app.use(annotationsRouter(context));
    app.use(bugsRouter(context));
    app.use(aiRouter(context));
    app.use(settingsRouter(context));
  }

  app.use((_req, res) => {
    res.status(404).json({ ok: false, error: { code: 'not_found', message: 'Route not found' } });
  });

  const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof MarkitHttpError) {
      res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message } });
      return;
    }
    const message = err instanceof Error ? err.message : 'Unknown server error';
    res.status(500).json({ ok: false, error: { code: 'internal_error', message } });
  };
  app.use(errorHandler);

  return app;
}
