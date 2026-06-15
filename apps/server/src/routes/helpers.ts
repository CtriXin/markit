import type { RequestHandler } from 'express';
import type { Database, SqlValue } from 'sql.js';

export type Row = Record<string, SqlValue>;

export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function first(db: Database, sql: string, params: SqlValue[] = []): Row | undefined {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    if (!stmt.step()) return undefined;
    return stmt.getAsObject();
  } finally {
    stmt.free();
  }
}

export function all(db: Database, sql: string, params: SqlValue[] = []): Row[] {
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

export function parseJson<T>(value: SqlValue | undefined, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  return JSON.parse(String(value)) as T;
}

export function nowIso(): string {
  return new Date().toISOString();
}
