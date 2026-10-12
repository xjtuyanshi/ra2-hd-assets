import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { createReadStream, readFileSync, readdirSync, renameSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PreviewServer, ViteDevServer } from 'vite';
import { createGameRelay } from 'relay-package/server';
import { parseRelayFaultConfig } from 'relay-package/faults';
import { createThirdPartyCacheHandler } from './src/server/thirdPartyCache';
import { createStallLogHandler } from './src/server/perfStallLog';

type ViteHttpServer = NonNullable<ViteDevServer['httpServer']> | NonNullable<PreviewServer['httpServer']>;

/**
 * Expose local, Git-ignored original game/ resources to the browser at /game/*.
 * For example, fetch('/game/Title.bmp') reads the original data file without copying assets.
 */
const GAME_DIR = resolve(process.env.RA2_GAME_ROOT || fileURLToPath(new URL('./game', import.meta.url)));

function gameAssetsPlugin(): Plugin {
  return {
    name: 'ra2:game-assets',
    configureServer(server) {
      // The cache stays outside public/dist; production builds and preview do not expose this endpoint.
      server.middlewares.use(
        '/__third-party',
        createThirdPartyCacheHandler(
          resolve(
            process.env.RA2_THIRD_PARTY_CACHE_DIR || fileURLToPath(new URL('./.tmp-third-party', import.meta.url)),
          ),
        ),
      );
      server.middlewares.use('/game', serveGameAsset);
      // The native launcher waits for the real page area before starting the
      // original game. This private endpoint never exposes paths or credentials.
      server.middlewares.use('/__native/viewport', (req, res) => {
        const viewportPath = process.env.RA2_NATIVE_VIEWPORT_STATUS;
        const token = process.env.RA2_NATIVE_SESSION_TOKEN;
        if (
          !['GET', 'POST'].includes(req.method ?? '') ||
          !viewportPath ||
          !token ||
          req.headers.authorization !== `Bearer ${token}` ||
          req.socket.remoteAddress !== '127.0.0.1'
        ) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json');
        if (req.method === 'GET') {
          try {
            const status = JSON.parse(readFileSync(viewportPath, 'utf8'));
            res.end(JSON.stringify({ ready: status.ready === true, resolution: status.resolution ?? null }));
          } catch {
            res.end(JSON.stringify({ ready: false, resolution: null }));
          }
          return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 512) req.destroy();
        });
        req.on('end', () => {
          try {
            const { width, height, dpr, devicePixelsPerGamePixel, frameWidth, frameHeight, followIni } =
              JSON.parse(body);
            if (
              ![width, height, dpr].every(Number.isFinite) ||
              width <= 0 ||
              width > 16384 ||
              height <= 0 ||
              height > 16384 ||
              dpr < 0.5 ||
              dpr > 8 ||
              (devicePixelsPerGamePixel !== undefined && ![2, 2.5, 3].includes(devicePixelsPerGamePixel)) ||
              (followIni !== undefined && typeof followIni !== 'boolean') ||
              ((frameWidth !== undefined || frameHeight !== undefined) &&
                (!Number.isSafeInteger(frameWidth) ||
                  !Number.isSafeInteger(frameHeight) ||
                  frameWidth < 800 ||
                  frameHeight < 600 ||
                  frameWidth > 2560 ||
                  frameHeight > 1600))
            )
              throw new Error('Invalid viewport');
            // The first report owns this launch's size; retries and resize
            // notifications cannot replace it while the game is starting.
            try {
              const current = JSON.parse(readFileSync(viewportPath, 'utf8'));
              if (current.viewport) {
                res.end(JSON.stringify({ ready: current.ready === true, resolution: current.resolution ?? null }));
                return;
              }
            } catch {}
            writeFileSync(
              `${viewportPath}.tmp`,
              JSON.stringify({
                viewport: {
                  width,
                  height,
                  dpr,
                  ...(devicePixelsPerGamePixel === undefined ? {} : { devicePixelsPerGamePixel }),
                  ...(frameWidth === undefined ? {} : { frameWidth, frameHeight }),
                  ...(followIni === undefined ? {} : { followIni }),
                },
                ready: false,
              }),
              { mode: 0o600 },
            );
            renameSync(`${viewportPath}.tmp`, viewportPath);
            res.end(JSON.stringify({ ready: false, resolution: null }));
          } catch {
            res.statusCode = 400;
            res.end('{}');
          }
        });
      });
      // The launcher exposes only this run's coarse state, never its private
      // paths, process identity, credentials or helper diagnostics.
      server.middlewares.use('/__native/session', (req, res) => {
        const statusPath = process.env.RA2_NATIVE_SESSION_STATUS;
        const token = process.env.RA2_NATIVE_SESSION_TOKEN;
        if (
          req.method !== 'GET' ||
          !statusPath ||
          !token ||
          req.headers.authorization !== `Bearer ${token}` ||
          req.socket.remoteAddress !== '127.0.0.1'
        ) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json');
        try {
          let { state } = JSON.parse(readFileSync(statusPath, 'utf8'));
          if (!['running', 'closed', 'failed'].includes(state)) throw new Error('Invalid launch status');
          if (state === 'running' && process.env.RA2_NATIVE_LAUNCH_STATUS) {
            // The helper observes process exit before its Wine wrapper exits.
            // Read its atomic status so normal quit does not race that wrapper.
            try {
              const game = JSON.parse(readFileSync(process.env.RA2_NATIVE_LAUNCH_STATUS, 'utf8'));
              if (game.running === false) state = game.exitCode === 0 ? 'closed' : 'failed';
            } catch {
              // Unavailable helper state never confirms a normal exit.
            }
          }
          res.end(JSON.stringify({ state }));
        } catch {
          res.statusCode = 503;
          res.end('{}');
        }
      });
      // HD remaster bridge (dev only): the locally extracted HD cache, derived from the player's own files.
      server.middlewares.use('/hd-cache', serveHdCache);
      // Stall records of the HD page and the play page's game-speed records (dev only) go to the file RA2_PERF_LOG
      // names, one JSON line each (speed records carry `kind: "speed"`); without it both routes answer 404.
      server.middlewares.use(
        '/__perf/stalls',
        createStallLogHandler(process.env.RA2_PERF_LOG ? resolve(process.env.RA2_PERF_LOG) : undefined),
      );
      server.middlewares.use(
        '/__perf/speed',
        createStallLogHandler(process.env.RA2_PERF_LOG ? resolve(process.env.RA2_PERF_LOG) : undefined),
      );
    },
    configurePreviewServer(server) {
      server.middlewares.use('/game', serveGameAsset);
    },
  };
}

function ra2NetworkRelayPlugin(): Plugin {
  return {
    name: 'ra2:network-relay',
    configureServer(server) {
      attachRa2NetworkRelay(server);
    },
    configurePreviewServer(server) {
      attachRa2NetworkRelay(server);
    },
  };
}

/** attachDplayRelay needs only these two members; dev/preview servers are structural subsets. */
interface RelayHostServer {
  httpServer: ViteHttpServer | null;
  close(): Promise<void>;
}

/** Mount the RA2 virtual-LAN relay at /ra2. */
function attachRa2NetworkRelay(server: RelayHostServer): void {
  const httpServer = server.httpServer;
  if (!httpServer) return;
  const relay = createGameRelay({ faults: parseRelayFaultConfig(process.env.RA2_NET_FAULTS) });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
    } catch {
      return;
    }
    if (pathname !== '/ra2') return;
    relay.handleUpgrade(request, socket, head);
  };
  httpServer.on('upgrade', onUpgrade);
  httpServer.once('close', () => httpServer.off('upgrade', onUpgrade));
  const originalClose = server.close.bind(server);
  server.close = async () => {
    relay.close();
    await relay.drained();
    return originalClose();
  };
}

const HD_CACHE_DIR = resolve(
  process.env.RA2_HD_CACHE_DIR || fileURLToPath(new URL('./gameres/hd-cache', import.meta.url)),
);
// The private native-host worktree stages its pointer art separately so both
// launchers can use it without replacing or rewriting the owner's base cache.
const repositoryDirectory = fileURLToPath(new URL('.', import.meta.url));
const stagedCursorDirectory =
  basename(repositoryDirectory) === 'native-host' && basename(dirname(repositoryDirectory)) === '.worktrees'
    ? resolve(repositoryDirectory, '../../gameres/s2x/native/phase19/farm-layer/_ui/cursor')
    : undefined;
const cursorDirectory = process.env.RA2_HD_CURSOR_DIR ?? stagedCursorDirectory;
const HD_CURSOR_DIR = (() => {
  if (!cursorDirectory || cursorDirectory === '0') return null;
  const directory = resolve(cursorDirectory);
  try {
    // Keep the manifest and atlas in one layer; a partially supplied layer must
    // not pair different-scale metadata with the base cache's original atlas.
    return statSync(join(directory, 'cursor.json')).isFile() && statSync(join(directory, 'cursor.png')).isFile()
      ? directory
      : null;
  } catch {
    return null;
  }
})();
const HD_CACHE_TYPES: Record<string, string> = { '.json': 'application/json', '.png': 'image/png' };

/** Serve the private cache and optional cursor layer, preserving game-owned filename casing. */
export function serveHdCache(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    res.end();
    return;
  }
  let urlPath: string;
  try {
    urlPath = decodeURIComponent((req.url ?? '').split('?')[0]!);
  } catch {
    res.statusCode = 400;
    res.end('bad path');
    return;
  }
  const parts = urlPath.split('/').filter(Boolean);
  const cursorLayer = HD_CURSOR_DIR && parts[0]?.toLowerCase() === '_ui' && parts[1]?.toLowerCase() === 'cursor';
  const root = cursorLayer ? HD_CURSOR_DIR! : HD_CACHE_DIR;
  const fileParts = cursorLayer ? parts.slice(2) : parts;
  let current = root;
  let file: Stats;
  try {
    if (!fileParts.length || parts.some((part) => part === '.' || part === '..')) throw new Error('bad path');
    for (const part of fileParts) {
      const actual = readdirSync(current).find((name) => name.toLowerCase() === part.toLowerCase());
      if (!actual) throw new Error('missing');
      current = join(current, actual);
    }
    const inside = relative(root, current);
    if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('missing');
    file = statSync(current);
    if (!file.isFile()) throw new Error('missing');
  } catch {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  // Reuse private browser bytes across launcher sessions, but validate every request so regenerated artwork is
  // visible immediately. ctime and inode also change when an exporter preserves size/mtime or replaces a file.
  const etag = `W/"${file.ino.toString(16)}-${file.size.toString(16)}-${file.mtimeMs.toString(16)}-${file.ctimeMs.toString(16)}"`;
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', file.mtime.toUTCString());
  res.setHeader('Content-Type', HD_CACHE_TYPES[extname(current).toLowerCase()] ?? 'application/octet-stream');
  const tags = req.headers['if-none-match'];
  const modifiedSince = req.headers['if-modified-since'];
  const unchanged =
    tags !== undefined
      ? tags.split(',').some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag.slice(2))
      : // Date-only validators lose subsecond precision; be conservative if the file changed within that second.
        modifiedSince !== undefined &&
        Number.isFinite(Date.parse(modifiedSince)) &&
        file.mtimeMs <= Date.parse(modifiedSince);
  if (unchanged) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.setHeader('Content-Length', file.size);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  sendFile(res, current);
}

/**
 * Stream a file that was just resolved. It can still vanish or become unreadable before it is opened (an hd:* command
 * rewriting the cache, the game directory being edited, a permission change); without an error listener the stream's
 * error event is uncaught and takes the whole development server down, including the VM's /game assets.
 */
function sendFile(res: ServerResponse, path: string, range?: { start: number; end: number }): void {
  const stream = createReadStream(path, range);
  res.once('close', () => stream.destroy());
  stream.once('error', () => {
    if (res.headersSent) {
      // Part of the body is out: cut the response so the client sees a truncated transfer, not a short file.
      res.destroy();
      return;
    }
    for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified'])
      res.removeHeader(name);
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('not found');
  });
  stream.pipe(res);
}

function serveGameAsset(req: IncomingMessage, res: ServerResponse): void {
  const rawUrl = req.url ?? '';
  const query = rawUrl.split('?')[1] ?? '';
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(rawUrl.split('?')[0]);
  } catch {
    res.statusCode = 400;
    res.end('bad path');
    return;
  }
  // Game-directory enumeration endpoint for browser EXE discovery, such as /game/.list?dir=ra2.
  if (urlPath === '/.list') {
    const directory = new URLSearchParams(query).get('dir') ?? '';
    const target = resolveGameDirectory(directory);
    if (!target) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    try {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(readdirSync(target)));
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
    return;
  }
  const resolved = resolveGameFile(urlPath);
  if (!resolved) {
    // Terminate within /game; passing to Vite's SPA fallback would mistake index.html for a game file.
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  let st: Stats;
  try {
    st = statSync(resolved);
  } catch {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'max-age=86400');
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
      if (start <= end && start < st.size) {
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', String(end - start + 1));
        sendFile(res, resolved, { start, end });
        return;
      }
    }
  }
  res.statusCode = 200;
  res.setHeader('Content-Length', String(st.size));
  sendFile(res, resolved);
}

/** Directory counterpart of resolveGameFile: resolve each level case-insensitively; the result must be a directory within GAME_DIR. */
function resolveGameDirectory(urlPath: string): string | null {
  if (!urlPath) return GAME_DIR;
  const parts = urlPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return null;
  let current = GAME_DIR;
  try {
    for (const part of parts) {
      const actual = readdirSync(current).find((name) => name.toLowerCase() === part.toLowerCase());
      if (!actual) return null;
      current = join(current, actual);
    }
    return statSync(current).isDirectory() && isWithinGameDirectory(current) ? current : null;
  } catch {
    return null;
  }
}

/** Original directory and file names use inconsistent casing; resolve each level case-insensitively. */
function resolveGameFile(urlPath: string): string | null {
  const parts = urlPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return null;
  let current = GAME_DIR;
  try {
    for (const part of parts) {
      const actual = readdirSync(current).find((name) => name.toLowerCase() === part.toLowerCase());
      if (!actual) return null;
      current = join(current, actual);
    }
    return statSync(current).isFile() && isWithinGameDirectory(current) ? current : null;
  } catch {
    return null;
  }
}

/** Cross-platform check that the resolved path remains within the game root; Windows uses backslashes, so do not hardcode '/'. */
function isWithinGameDirectory(candidate: string): boolean {
  const relativePath = relative(resolve(GAME_DIR), resolve(candidate));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

export default defineConfig({
  // RA2_DEV_HTTP=1 serves plain HTTP for local tooling that rejects the self-signed certificate; localhost stays a secure context.
  plugins: [...(process.env.RA2_DEV_HTTP ? [] : [basicSsl()]), gameAssetsPlugin(), ra2NetworkRelayPlugin()],
  // VM pages with hmr=false cannot rely on reloads to handle a second prebundle. Register JSX and Worker dynamic dependencies
  // up front to avoid a second React instance in lazy pages. This only builds development caches; browser experiments are not preloaded.
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'fflate',
      'v86',
      '7z-wasm',
      'onnxruntime-web/webgpu',
    ],
  },
  server: {
    host: true, // Listen on 0.0.0.0 so other LAN devices can connect (the terminal prints the Network address)
    port: 15174,
    strictPort: true,
    // VMs and long regressions are stateful; code changes must not reload pages or destroy VMs under test.
    hmr: false,
    // Disable caching in development to prevent stale modules during hot updates/hard reloads (previously mixed old and new map.ts code).
    // The /game resource middleware sets its own max-age=86400 and is unaffected.
    headers: { 'Cache-Control': 'no-store' },
    fs: { allow: ['.'] },
  },
  preview: { port: 4174, strictPort: true },
  build: { target: 'es2022' },
  worker: {
    // vmClient.ts starts a module Worker with new Worker(new URL('./vmWorker.ts', import.meta.url), { type: 'module' }).
    // Vite requires ES output for code-split Workers; the default iife format fails.
    format: 'es',
  },
});
