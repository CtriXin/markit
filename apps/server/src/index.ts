import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createServerContext } from './context.js';

const config = loadConfig();
const context = await createServerContext();
const app = createApp(context);

const server = app.listen(config.port, config.host, () => {
  console.log(`Markit server listening on http://${config.host}:${config.port}`);
});

async function shutdown() {
  server.close();
  await context.runtime.close();
  await context.database.save();
}

process.once('SIGINT', () => void shutdown().then(() => process.exit(0)));
process.once('SIGTERM', () => void shutdown().then(() => process.exit(0)));
