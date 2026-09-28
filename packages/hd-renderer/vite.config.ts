import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The HD cache (gameres/hd-cache/<map>/) is derived from the player's own game files: serve it in development only and
// never copy it into a build.
const hdCache = fileURLToPath(new URL('../../gameres/hd-cache', import.meta.url));

export default defineConfig(({ command }) => ({
  root: 'sandbox',
  publicDir: command === 'serve' ? hdCache : false,
  server: { port: 15180, strictPort: true, host: 'localhost' },
  build: { target: 'es2022', outDir: '../dist-sandbox', emptyOutDir: true },
}));
