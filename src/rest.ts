import { randomUUID } from 'node:crypto';

import type { Api } from './context.js';
import { refusalOf } from './mcp.js';

/** A request MoleSignal's API refused, with its status and what it said. */
export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A multipart form of text fields and one file, as bytes with its content
 * type: built here so that any fetch, proxied or not, sends it the same.
 */
export function multipartForm(fields: Record<string, string | undefined>, file: { name: string; bytes: Uint8Array }): {
  body: Uint8Array;
  contentType: string;
} {
  const boundary = `molesignal-${randomUUID()}`;
  const parts: Uint8Array[] = [];
  const text = (value: string) => parts.push(Buffer.from(value, 'utf8'));
  const escape = (value: string) => value.replace(/["\r\n\\]/g, (character) => encodeURIComponent(character));

  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    text(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  text(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escape(file.name)}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  );
  parts.push(file.bytes);
  text(`\r\n--${boundary}--\r\n`);

  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** What a refusal means, said so that the person knows what to do. */
function describe(status: number, said: string | undefined): string {
  const because = said ? `: ${said}` : '';
  if (status === 401) return `MoleSignal refused the API token (HTTP 401${because}); create a new one, or check MOLESIGNAL_TOKEN`;
  if (status === 403) return `MoleSignal refused the request (HTTP 403${because}); the token's role may lack the permission`;
  if (status === 404) return `Not found (HTTP 404${because})`;
  if (status === 413) return `The request is larger than MoleSignal takes (HTTP 413${because})`;
  return `MoleSignal answered HTTP ${status}${because}`;
}

/**
 * Calls MoleSignal's API under `/api/v1` with the API token: JSON in and
 * out, or a form for uploads. An answer that is not 2xx is an ApiError.
 */
export async function apiRequest(
  api: Api,
  method: string,
  path: string,
  options: {
    json?: unknown;
    /** A body as it is, such as a multipart upload, with its content type. */
    raw?: { body: Uint8Array; contentType: string } | undefined;
    query?: Record<string, string | undefined>;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<unknown> {
  const url = new URL(`${api.connection.url}/api/v1${path}`);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value) url.searchParams.set(name, value);
  }

  const headers: Record<string, string> = {
    authorization: `Bearer ${api.connection.token}`,
    accept: 'application/json',
  };
  let body: string | Uint8Array | undefined;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.raw) {
    headers['content-type'] = options.raw.contentType;
    body = options.raw.body;
  }

  const response = await api.fetch(url, { method, headers, body: body as RequestInit['body'], signal: options.signal });
  const text = await response.text();
  if (!response.ok) throw new ApiError(response.status, describe(response.status, refusalOf(text)));
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
