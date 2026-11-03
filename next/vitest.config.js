import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The browser gets this from the import map.
    alias: { '@twp/client': fileURLToPath(new URL('./client/lib/index.js', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 15000,
  },
});
