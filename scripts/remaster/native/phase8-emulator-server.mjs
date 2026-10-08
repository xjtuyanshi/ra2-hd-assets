#!/usr/bin/env node
// Start the owner's existing Vite configuration without writing config bundles or dependency caches to its checkout.
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const checkout = resolve(process.argv[2]);
const cacheDir = resolve(process.argv[3]);
assert(checkout.endsWith('/.worktrees/s2-play8'));
assert(cacheDir.includes('/gameres/s2x/native/phase8/'));
const { createServer } = await import(pathToFileURL(join(checkout, 'node_modules/vite/dist/node/index.js')).href);
const server = await createServer({
  root: checkout,
  configFile: join(checkout, 'vite.config.ts'),
  configLoader: 'runner',
  cacheDir,
  server: { port: 15452, strictPort: true, host: 'localhost' },
});
await server.listen();
server.printUrls();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
