import { defineConfig } from 'vitest/config';

// Basic tests need no game assets; real games live under tests/real-game, where CI strict mode rejects missing resources.
export default defineConfig({
  test: {
    // Prevent accidental it.only / describe.only commits from making CI report success after running only part of the suite.
    allowOnly: false,
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts', 'packages/ra2-formats/src/**/*.test.ts'],
    // Vendored ra2-formats integration tests need a real install; they are not vendored, but keep them out if added.
    exclude: ['**/node_modules/**', '**/*.integration.test.ts'],
    testTimeout: 20_000,
  },
});
