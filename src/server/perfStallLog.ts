import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Largest request body accepted: a batch is at most a few dozen records of a few hundred bytes. */
export const STALL_LOG_MAX_BYTES = 256 * 1024;
/** Most records taken from one request. */
export const STALL_LOG_MAX_ENTRIES = 500;

export interface StallLogOptions {
  maxBytes?: number;
  maxEntries?: number;
  /** Appends text to the log file (default: node's appendFile, creating the directory first). */
  append?: (file: string, text: string) => Promise<void>;
  /** Wall clock for the `received` field (default Date.now). */
  now?: () => number;
}

/**
 * Development-server sink for the page's stall recorder: `POST <mount>` with a JSON array of records appends one
 * JSON line per record to `file`, each with the time it was received. Register only in Vite development (see
 * vite.config.ts): the production build and `vite preview` have no such route.
 *
 * `file` is the server operator's choice (RA2_PERF_LOG), never the request's: without it the route answers 404 and
 * the page stops posting. Only same-origin JSON posts are taken (another site open in the same browser cannot write
 * to the log: a cross-origin JSON post needs a preflight this route does not answer, and a mismatching Origin is
 * refused), bodies over the limit are refused before they are read to the end, and what is written is the parsed
 * records serialized again, so a record can never span or forge a line.
 */
export function createStallLogHandler(file: string | undefined, options: StallLogOptions = {}) {
  const maxBytes = options.maxBytes ?? STALL_LOG_MAX_BYTES;
  const maxEntries = options.maxEntries ?? STALL_LOG_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const append =
    options.append ??
    (async (path: string, text: string) => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, text);
    });
  const reply = (response: ServerResponse, status: number, text = '') => {
    response.statusCode = status;
    response.setHeader('Cache-Control', 'no-store');
    response.end(text);
  };
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = request.url?.split('?')[0] ?? '';
    if (path !== '' && path !== '/') return reply(response, 404, 'not found');
    if (!file) return reply(response, 404, 'no stall log configured (RA2_PERF_LOG)');
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      return reply(response, 405);
    }
    const headers = request.headers ?? {};
    const origin = headers.origin;
    if (origin && headers.host && hostOf(origin) !== headers.host) return reply(response, 403, 'cross-origin');
    if (!String(headers['content-type'] ?? '').startsWith('application/json'))
      return reply(response, 415, 'application/json only');
    const declared = Number(headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) return reply(response, 413, 'too large');
    let body: string;
    try {
      body = await readBody(request, maxBytes);
    } catch (error) {
      return reply(
        response,
        error instanceof TooLarge ? 413 : 400,
        error instanceof TooLarge ? 'too large' : 'bad body',
      );
    }
    let entries: unknown;
    try {
      entries = JSON.parse(body);
    } catch {
      return reply(response, 400, 'not JSON');
    }
    if (!Array.isArray(entries) || entries.length > maxEntries || !entries.every(isRecord))
      return reply(response, 400, 'expected an array of records');
    if (!entries.length) return reply(response, 204);
    const received = new Date(now()).toISOString();
    const lines = entries.map((entry) => JSON.stringify({ received, ...entry }) + '\n').join('');
    try {
      await append(file, lines);
    } catch {
      return reply(response, 500, 'stall log unavailable');
    }
    reply(response, 204);
  };
}

class TooLarge extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/** The request body as UTF-8 text; rejects with TooLarge as soon as more than `limit` bytes have arrived. */
function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += bytes.length;
      if (size > limit) {
        // The rest is discarded as it arrives; the refusal goes out now.
        request.resume();
        finish(new TooLarge());
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => finish(null);
    const onError = (error: Error) => finish(error);
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}
