import initSqlJs, { type Database } from 'sql.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { applyMigrations } from './migrations.js';

export type MarkitDatabase = {
  db: Database;
  save: () => Promise<void>;
};

export async function openMarkitDatabase(filePath: string): Promise<MarkitDatabase> {
  const SQL = await initSqlJs();
  let db: Database;
  try {
    const bytes = await readFile(filePath);
    db = new SQL.Database(bytes);
  } catch {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON');
  applyMigrations(db);

  async function save() {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from(db.export()));
  }

  await save();
  return { db, save };
}
