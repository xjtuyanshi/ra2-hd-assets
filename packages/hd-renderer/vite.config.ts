import { defineConfig } from 'vite';

export default defineConfig({
  root: 'sandbox',
  server: { port: 15180, strictPort: true, host: 'localhost' },
  build: { target: 'es2022', outDir: '../dist-sandbox', emptyOutDir: true },
});
