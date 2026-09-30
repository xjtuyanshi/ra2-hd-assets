import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// The HD cache (gameres/hd-cache/<map>/) is derived from the player's own game files: serve it in development only and
// never copy it into a build. HD_CACHE_DIR points the sandbox at another cache root with the same layout (for example a
// variant tree whose files link back to hd-cache), so asset variants can be reviewed side by side.
const hdCache = process.env.HD_CACHE_DIR || fileURLToPath(new URL('../../gameres/hd-cache', import.meta.url));

export default defineConfig(({ command }) => ({
  root: 'sandbox',
  publicDir: command === 'serve' ? hdCache : false,
  server: { port: 15180, strictPort: true, host: 'localhost' },
  build: { target: 'es2022', outDir: '../dist-sandbox', emptyOutDir: true },
}));
