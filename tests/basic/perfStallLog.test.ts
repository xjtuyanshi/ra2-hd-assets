import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createStallLogHandler, STALL_LOG_MAX_BYTES, STALL_LOG_MAX_ENTRIES } from '../../src/server/perfStallLog';

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

interface Sent {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | (string | Buffer)[];
}

/** One request through the handler, as connect hands it over under the mount path. */
async function request(handler: ReturnType<typeof createStallLogHandler>, sent: Sent = {}) {
  const chunks = sent.body === undefined ? [] : Array.isArray(sent.body) ? sent.body : [sent.body];
  const incoming = Object.assign(Readable.from(chunks, { objectMode: false }), {
    url: sent.url ?? '/',
    method: sent.method ?? 'POST',
    headers: { host: 'localhost:15400', 'content-type': 'application/json', ...sent.headers },
  }) as unknown as IncomingMessage;
  let text: unknown;
  const headers = new Map<string, unknown>();
  const response = {
    statusCode: 200,
    setHeader: (name: string, value: unknown) => void headers.set(name, value),
    end: (value?: unknown) => void (text = value),
  };
  await handler(incoming, response as unknown as ServerResponse);
  return { status: response.statusCode, text, headers };
}

const records = [
  { seq: 1, gapMs: 412, cause: 'not-delivered', map: 'xmp29u2', newKinds: ['building:NAREFN'] },
  { seq: 2, gapMs: 1730, cause: 'main-thread', map: 'xmp29u2', newKinds: [] },
];

describe('开发服务器卡顿日志端点 (POST /__perf/stalls)', () => {
  it('appends one JSON line per record, with the time it was received, creating the folder', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ra2-stall-log-test-'));
    const file = join(directory, 'perfmon', 'stalls.jsonl');
    const handler = createStallLogHandler(file, { now: () => Date.UTC(2026, 9, 5, 21, 30, 0) });
    const first = await request(handler, { body: JSON.stringify(records) });
    expect(first.status).toBe(204);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    // A second batch is appended, never written over the first; a body may arrive in pieces.
    const more = JSON.stringify([{ seq: 3, gapMs: 200 }]);
    expect((await request(handler, { body: [more.slice(0, 9), more.slice(9)] })).status).toBe(204);
    const lines = (await readFile(file, 'utf8')).split('\n');
    expect(lines.pop()).toBe('');
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { received: '2026-10-05T21:30:00.000Z', ...records[0] },
      { received: '2026-10-05T21:30:00.000Z', ...records[1] },
      { received: '2026-10-05T21:30:00.000Z', seq: 3, gapMs: 200 },
    ]);
    // An empty batch is accepted and writes nothing.
    expect((await request(handler, { body: '[]' })).status).toBe(204);
    expect((await readFile(file, 'utf8')).split('\n')).toHaveLength(4);
  });

  it('writes what it parsed, so a record can neither span nor forge a line', async () => {
    const append = vi.fn(async () => undefined);
    const handler = createStallLogHandler('/log/stalls.jsonl', { append, now: () => 0 });
    const tricky = [{ map: 'a\nb', note: '{"received":"x"}\n{"forged":true}', received: 'client' }];
    expect((await request(handler, { body: JSON.stringify(tricky, null, 2) })).status).toBe(204);
    const [file, text] = append.mock.calls[0] as unknown as [string, string];
    expect(file).toBe('/log/stalls.jsonl');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(text)).toMatchObject({ map: 'a\nb', note: tricky[0]!.note });
  });

  it('refuses bodies over the limit, by their declared length and as they arrive', async () => {
    const append = vi.fn(async () => undefined);
    const handler = createStallLogHandler('/log/stalls.jsonl', { append });
    expect(STALL_LOG_MAX_BYTES).toBe(256 * 1024);
    const declared = await request(handler, {
      headers: { 'content-length': String(STALL_LOG_MAX_BYTES + 1) },
      body: '[]',
    });
    expect(declared.status).toBe(413);
    // No length declared (or a false one): counted while reading, refused once it is over.
    const small = createStallLogHandler('/log/stalls.jsonl', { append, maxBytes: 64 });
    const padded = JSON.stringify([{ note: 'x'.repeat(100) }]);
    expect((await request(small, { body: [padded.slice(0, 40), padded.slice(40)] })).status).toBe(413);
    expect((await request(small, { headers: { 'content-length': '10' }, body: padded })).status).toBe(413);
    expect((await request(small, { body: JSON.stringify([{ seq: 1 }]) })).status).toBe(204);
    expect(append).toHaveBeenCalledTimes(1);
    // Too many records in one request are refused as well.
    const many = JSON.stringify(Array.from({ length: STALL_LOG_MAX_ENTRIES + 1 }, (_, seq) => ({ seq })));
    expect((await request(handler, { body: many })).status).toBe(400);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('takes only same-origin JSON posts of an array of records, at its own path', async () => {
    const append = vi.fn(async () => undefined);
    const handler = createStallLogHandler('/log/stalls.jsonl', { append });
    const body = JSON.stringify(records);
    const get = await request(handler, { method: 'GET' });
    expect(get.status).toBe(405);
    expect(get.headers.get('Allow')).toBe('POST');
    expect((await request(handler, { url: '/other', body })).status).toBe(404);
    expect((await request(handler, { headers: { 'content-type': 'text/plain' }, body })).status).toBe(415);
    // Another site open in the same browser.
    expect((await request(handler, { headers: { origin: 'https://example.invalid' }, body })).status).toBe(403);
    expect((await request(handler, { headers: { origin: 'null' }, body })).status).toBe(403);
    expect((await request(handler, { headers: { origin: 'http://localhost:15400' }, body })).status).toBe(204);
    for (const bad of ['{', '{"seq":1}', '[1,2]', '[null]', '[[]]', '"text"'])
      expect((await request(handler, { body: bad })).status, bad).toBe(400);
    expect((await request(handler, { url: '/?batch=1', body })).status).toBe(204);
    expect(append).toHaveBeenCalledTimes(2);
  });

  it('answers 404 when no log is configured and 500 when the file cannot be written', async () => {
    const off = createStallLogHandler(undefined);
    expect((await request(off, { body: JSON.stringify(records) })).status).toBe(404);
    const broken = createStallLogHandler('/log/stalls.jsonl', {
      append: async () => {
        throw new Error('read-only');
      },
    });
    expect((await request(broken, { body: JSON.stringify(records) })).status).toBe(500);
  });
});

describe('the stall log route exists in development only', () => {
  const config = readFileSync(fileURLToPath(new URL('../../vite.config.ts', import.meta.url)), 'utf8');

  it('is mounted by the development server hook, on the file RA2_PERF_LOG names, and not by preview', () => {
    const mounts = [...config.matchAll(/'\/__perf\/stalls'/g)];
    expect(mounts).toHaveLength(1);
    const dev = config.indexOf('configureServer(server) {');
    const preview = config.indexOf('configurePreviewServer(server) {');
    expect(dev).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(dev);
    // Inside the first plugin's development hook: after it opens, before the preview hook.
    expect(mounts[0]!.index).toBeGreaterThan(dev);
    expect(mounts[0]!.index).toBeLessThan(preview);
    expect(config).toContain('createStallLogHandler(process.env.RA2_PERF_LOG ?');
  });

  it('is posted to only by a module the page loads behind import.meta.env.DEV', () => {
    const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    const bridge = source('../../src/ui/pages/game/hdBridge.ts');
    // The bridge names the monitor in a type import and in one dynamic import under the development flag.
    const imports = [...bridge.matchAll(/import\(\s*'\.\/hdStallMonitor'\s*\)/g)];
    expect(imports).toHaveLength(1);
    const guard = bridge.lastIndexOf('if (import.meta.env.DEV) {', imports[0]!.index);
    expect(guard).toBeGreaterThan(-1);
    expect(bridge.slice(guard, imports[0]!.index)).not.toContain('}');
    expect(bridge).not.toMatch(/import \{[^}]*\} from '\.\/hdStallMonitor'/);
    expect(bridge).not.toContain('__perf');
    for (const file of ['runtimeToolbar.ts', 'page.ts'])
      expect(source(`../../src/ui/pages/game/${file}`), file).not.toContain('__perf');
  });
});
