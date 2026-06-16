import { describe, expect, it } from 'vitest';
import { applyMigrations, createMemoryDatabase, getAppliedMigrationVersions, getUserVersion } from '../src/db/migrations.js';

function tableNames(db: Awaited<ReturnType<typeof createMemoryDatabase>>): string[] {
  const result = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC");
  return result[0]?.values.map((row) => String(row[0])) ?? [];
}

describe('SQLite migrations', () => {
  it('migrates empty DB to latest schema inside migration ledger', async () => {
    const db = await createMemoryDatabase();
    applyMigrations(db);
    applyMigrations(db);

    expect(getAppliedMigrationVersions(db)).toEqual([1, 2, 3]);
    expect(getUserVersion(db)).toBe(3);
    expect(tableNames(db)).toEqual(expect.arrayContaining([
      'schema_migrations',
      'settings',
      'sessions',
      'captures',
      'annotations',
      'bugs',
      'bug_annotations',
      'bug_assets',
      'ai_jobs',
      'ai_runs'
    ]));
  });
});
