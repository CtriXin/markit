export type ServerConfig = {
  host: '127.0.0.1';
  port: number;
  webOrigin: string;
};

function readPort(value: string | undefined): number {
  if (!value) return 4317;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid MARKIT_SERVER_PORT: ${value}`);
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: '127.0.0.1',
    port: readPort(env.MARKIT_SERVER_PORT),
    webOrigin: env.MARKIT_WEB_ORIGIN || 'http://127.0.0.1:5173'
  };
}
