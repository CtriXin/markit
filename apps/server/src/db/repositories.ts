import type { Database, SqlValue } from 'sql.js';

type Row = Record<string, SqlValue>;

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: SqlValue): T {
  return JSON.parse(String(value)) as T;
}

function now(): string {
  return new Date().toISOString();
}

function first(db: Database, sql: string, params: SqlValue[] = []): Row | undefined {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    if (!stmt.step()) return undefined;
    return stmt.getAsObject();
  } finally {
    stmt.free();
  }
}

function all(db: Database, sql: string, params: SqlValue[] = []): Row[] {
  const stmt = db.prepare(sql);
  const rows: Row[] = [];
  try {
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally {
    stmt.free();
  }
}

export function createRepositories(db: Database) {
  return {
    settings: {
      set(key: string, value: unknown) {
        db.run(
          `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
          [key, json(value), now()]
        );
      },
      get<T>(key: string): T | undefined {
        const row = first(db, 'SELECT value_json FROM settings WHERE key = ?', [key]);
        return row ? parseJson<T>(row.value_json!) : undefined;
      }
    },

    sessions: {
      insert(input: {
        id: string;
        sourceUrl: string;
        currentUrl: string;
        title?: string;
        viewport: unknown;
        runtimeStatus: string;
        projectSnapshot?: unknown;
      }) {
        const ts = now();
        db.run(
          `INSERT INTO sessions (id, source_url, current_url, title, viewport_json, runtime_status, project_snapshot_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [input.id, input.sourceUrl, input.currentUrl, input.title ?? '', json(input.viewport), input.runtimeStatus, input.projectSnapshot ? json(input.projectSnapshot) : null, ts, ts]
        );
      },
      get(id: string) {
        return first(db, 'SELECT * FROM sessions WHERE id = ?', [id]);
      },
      list() {
        return all(db, 'SELECT * FROM sessions ORDER BY created_at ASC');
      },
      updateStatus(id: string, status: string) {
        db.run('UPDATE sessions SET runtime_status = ?, updated_at = ? WHERE id = ?', [status, now(), id]);
      }
    },

    captures: {
      insert(input: {
        id: string;
        sessionId: string;
        sessionVersion: number;
        url: string;
        finalUrl: string;
        title?: string;
        viewport: unknown;
        scrollX: number;
        scrollY: number;
        mode: string;
        screenshotPath: string;
        domTargetsPath: string;
        imageWidth: number;
        imageHeight: number;
      }) {
        db.run(
          `INSERT INTO captures (id, session_id, session_version, url, final_url, title, viewport_json, scroll_x, scroll_y, mode, screenshot_path, dom_targets_path, image_width, image_height, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.id,
            input.sessionId,
            input.sessionVersion,
            input.url,
            input.finalUrl,
            input.title ?? '',
            json(input.viewport),
            input.scrollX,
            input.scrollY,
            input.mode,
            input.screenshotPath,
            input.domTargetsPath,
            input.imageWidth,
            input.imageHeight,
            now()
          ]
        );
      },
      get(id: string) {
        return first(db, 'SELECT * FROM captures WHERE id = ?', [id]);
      },
      listBySession(sessionId: string) {
        return all(db, 'SELECT * FROM captures WHERE session_id = ? ORDER BY created_at ASC', [sessionId]);
      }
    },

    annotations: {
      insert(input: { id: string; captureId: string; kind: string; geometry: unknown; target?: unknown; note?: string; colorRole: string }) {
        const ts = now();
        db.run(
          `INSERT INTO annotations (id, capture_id, kind, geometry_json, target_json, note, color_role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [input.id, input.captureId, input.kind, json(input.geometry), input.target ? json(input.target) : null, input.note ?? '', input.colorRole, ts, ts]
        );
      },
      get(id: string) {
        return first(db, 'SELECT * FROM annotations WHERE id = ?', [id]);
      },
      delete(id: string) {
        db.run('DELETE FROM annotations WHERE id = ?', [id]);
      }
    },

    bugs: {
      insert(input: {
        id: string;
        sessionId: string;
        title?: string;
        actual?: string;
        expected?: string;
        severity: string;
        status: string;
        sourceUrl: string;
        finalUrl: string;
        primaryCaptureId?: string;
        tags?: string[];
        references?: unknown[];
      }) {
        const ts = now();
        db.run(
          `INSERT INTO bugs (id, session_id, title, actual, expected, severity, status, source_url, final_url, primary_capture_id, tags_json, references_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.id,
            input.sessionId,
            input.title ?? '',
            input.actual ?? '',
            input.expected ?? '',
            input.severity,
            input.status,
            input.sourceUrl,
            input.finalUrl,
            input.primaryCaptureId ?? null,
            json(input.tags ?? []),
            json(input.references ?? []),
            ts,
            ts
          ]
        );
      },
      get(id: string) {
        return first(db, 'SELECT * FROM bugs WHERE id = ?', [id]);
      },
      updateStatus(id: string, status: string) {
        db.run('UPDATE bugs SET status = ?, updated_at = ? WHERE id = ?', [status, now(), id]);
      }
    },

    bugAnnotations: {
      add(bugId: string, annotationId: string, sortOrder: number) {
        db.run('INSERT INTO bug_annotations (bug_id, annotation_id, sort_order) VALUES (?, ?, ?)', [bugId, annotationId, sortOrder]);
      },
      listForBug(bugId: string) {
        return all(db, 'SELECT * FROM bug_annotations WHERE bug_id = ? ORDER BY sort_order ASC', [bugId]);
      },
      remove(bugId: string, annotationId: string) {
        db.run('DELETE FROM bug_annotations WHERE bug_id = ? AND annotation_id = ?', [bugId, annotationId]);
      }
    },

    aiJobs: {
      insert(input: { id: string; sessionId: string; bugId?: string; captureId?: string; status: string; request: unknown }) {
        const ts = now();
        db.run(
          `INSERT INTO ai_jobs (id, session_id, bug_id, capture_id, status, request_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [input.id, input.sessionId, input.bugId ?? null, input.captureId ?? null, input.status, json(input.request), ts, ts]
        );
      },
      get(id: string) {
        return first(db, 'SELECT * FROM ai_jobs WHERE id = ?', [id]);
      },
      updateStatus(id: string, status: string, response?: unknown) {
        db.run('UPDATE ai_jobs SET status = ?, response_json = ?, updated_at = ? WHERE id = ?', [status, response ? json(response) : null, now(), id]);
      }
    },

    aiRuns: {
      insert(input: { id: string; jobId: string; provider: string; model: string; tracePath: string; latencyMs?: number; schemaValid: boolean }) {
        db.run(
          `INSERT INTO ai_runs (id, job_id, provider, model, trace_path, latency_ms, schema_valid, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [input.id, input.jobId, input.provider, input.model, input.tracePath, input.latencyMs ?? null, input.schemaValid ? 1 : 0, now()]
        );
      },
      listForJob(jobId: string) {
        return all(db, 'SELECT * FROM ai_runs WHERE job_id = ? ORDER BY created_at ASC', [jobId]);
      }
    }
  };
}
