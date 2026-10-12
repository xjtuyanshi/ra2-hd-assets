import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createThirdPartyCacheHandler } from '../../src/server/thirdPartyCache';

let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('private HD cache validation', () => {
  it('reuses unchanged bytes but revalidates regenerated art even when size and mtime stay unchanged', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ra2-hd-cache-test-'));
    const file = join(directory, 'Asset.json');
    await writeFile(file, 'first');
    await utimes(file, 10, 10);
    vi.stubEnv('RA2_HD_CACHE_DIR', directory);
    const { serveHdCache } = await import('../../vite.config');
    const request = (headers: Record<string, string> = {}, url = '/asset.json') => {
      const response = {
        statusCode: 200,
        headers: new Map<string, unknown>(),
        setHeader(name: string, value: unknown) {
          this.headers.set(name, value);
        },
        end() {},
      };
      serveHdCache({ url, method: 'HEAD', headers } as IncomingMessage, response as unknown as ServerResponse);
      return response;
    };
    const first = request();
    expect(first.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
    expect(first.headers.get('Content-Length')).toBe(5);
    const etag = String(first.headers.get('ETag'));
    expect(request({ 'if-none-match': etag }).statusCode).toBe(304);
    expect(request({ 'if-modified-since': String(first.headers.get('Last-Modified')) }).statusCode).toBe(304);
    await writeFile(file, 'other');
    await utimes(file, 10, 10);
    const changed = request({ 'if-none-match': etag, 'if-modified-since': 'Wed, 01 Jan 2100 00:00:00 GMT' });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.get('ETag')).not.toBe(etag);
    const missing = request({}, '/missing.json');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers.get('Cache-Control')).toBe('no-store');
    expect(missing.headers.has('ETag')).toBe(false);
  });

  it('uses a complete pointer layer only for cursor assets and retains the base cache for incomplete layers', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ra2-cursor-layer-test-'));
    const base = join(directory, 'base');
    const layer = join(directory, 'pointer');
    await mkdir(join(base, '_ui', 'cursor'), { recursive: true });
    await mkdir(layer);
    await writeFile(join(base, '_ui', 'cursor', 'cursor.json'), 'original');
    await writeFile(join(base, 'map.json'), 'terrain');
    await writeFile(join(layer, 'cursor.json'), 'hd');
    await writeFile(join(layer, 'cursor.png'), 'hd-art');
    vi.stubEnv('RA2_HD_CACHE_DIR', base);
    vi.stubEnv('RA2_HD_CURSOR_DIR', layer);
    let { serveHdCache } = await import('../../vite.config');
    const request = (url: string) => {
      const headers = new Map<string, unknown>();
      const response = {
        statusCode: 200,
        setHeader(name: string, value: unknown) {
          headers.set(name, value);
        },
        end() {},
      };
      serveHdCache({ url, method: 'HEAD', headers: {} } as IncomingMessage, response as unknown as ServerResponse);
      return { status: response.statusCode, length: headers.get('Content-Length') };
    };
    expect(request('/_UI/CURSOR/cursor.json')).toEqual({ status: 200, length: 2 });
    expect(request('/map.json')).toEqual({ status: 200, length: 7 });
    expect(request('/_ui/cursor/../map.json').status).toBe(404);
    await rm(join(layer, 'cursor.png'));
    vi.resetModules();
    ({ serveHdCache } = await import('../../vite.config'));
    expect(request('/_ui/cursor/cursor.json')).toEqual({ status: 200, length: 8 });
  });
});

describe('开发主程序缓存端点', () => {
  it('只提供指定 EXE，缺失返回 404，不落入 SPA HTML', async () => {
    directory = await mkdtemp(join(tmpdir(), 'ra2-third-party-test-'));
    await writeFile(join(directory, 'game.exe'), new Uint8Array([77, 90]));
    const handler = createThirdPartyCacheHandler(directory);
    async function request(url: string, method = 'GET') {
      let body: unknown;
      const headers = new Map();
      const response = {
        statusCode: 200,
        setHeader(name: string, value: unknown) {
          headers.set(name, value);
        },
        end(value: unknown) {
          body = value;
        },
      };
      await handler({ url, method } as IncomingMessage, response as unknown as ServerResponse);
      return { status: response.statusCode, headers, body };
    }
    const result = await request('/game.exe');
    expect(result.status).toBe(200);
    expect(result.body).toEqual(Buffer.from([77, 90]));
    expect(result.headers.get('Cache-Control')).toBe('no-store');
    expect((await request('/game.exe', 'HEAD')).body).toBeUndefined();
    expect((await request('/gamemd.exe')).status).toBe(404);
    expect((await request('/game.exe', 'POST')).status).toBe(405);
    for (const path of ['/', '/../game.exe', '/%2e%2e/game.exe', '/secret.txt']) {
      expect((await request(path)).status).toBe(404);
    }
  });
});
