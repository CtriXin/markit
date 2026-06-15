export class MarkitHttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function parseHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MarkitHttpError(400, 'invalid_url', 'URL is invalid');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MarkitHttpError(400, 'invalid_url_scheme', `Unsupported URL scheme: ${url.protocol || 'empty'}`);
  }
  return url;
}
