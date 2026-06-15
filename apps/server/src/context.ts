import { join, resolve } from 'node:path';
import { openMarkitDatabase, type MarkitDatabase } from './db/database.js';
import { createRepositories } from './db/repositories.js';
import { BrowserRuntime } from './runtime/browser.js';

export type ServerContext = {
  dataDir: string;
  database: MarkitDatabase;
  repos: ReturnType<typeof createRepositories>;
  runtime: BrowserRuntime;
};

export async function createServerContext(options: { dataDir?: string } = {}): Promise<ServerContext> {
  const cwd = process.cwd();
  const defaultDataDir = cwd.endsWith(join('apps', 'server')) ? resolve(cwd, '..', '..', '.markit') : join(cwd, '.markit');
  const dataDir = options.dataDir ?? process.env.MARKIT_DATA_DIR ?? defaultDataDir;
  const database = await openMarkitDatabase(join(dataDir, 'app.sqlite'));
  return {
    dataDir,
    database,
    repos: createRepositories(database.db),
    runtime: new BrowserRuntime()
  };
}
