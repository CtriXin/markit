import initSqlJs, { type Database } from 'sql.js';
import { markitMigrations, type Migration } from './schema.js';

export async function createMemoryDatabase(): Promise<Database> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  return db;
}

export function applyMigrations(db: Database, migrations: Migration[] = markitMigrations): void {
  db.run(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`);

  const applied = new Set(getAppliedMigrationVersions(db));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.run('BEGIN TRANSACTION');
    try {
      db.run(migration.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        new Date().toISOString()
      ]);
      db.run(`PRAGMA user_version = ${migration.version}`);
      db.run('COMMIT');
    } catch (error) {
      db.run('ROLLBACK');
      throw error;
    }
  }
}

export function getAppliedMigrationVersions(db: Database): number[] {
  try {
    const result = db.exec('SELECT version FROM schema_migrations ORDER BY version ASC');
    if (!result[0]) return [];
    return result[0].values.map((row) => Number(row[0]));
  } catch {
    return [];
  }
}

export function getUserVersion(db: Database): number {
  const result = db.exec('PRAGMA user_version');
  return Number(result[0]?.values[0]?.[0] ?? 0);
}
