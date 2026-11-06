import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The browser gets this from the import map.
    alias: { '@twp/client': fileURLToPath(new URL('./client/lib/index.js', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.js'],
    // Worktrees carry their own copy of every test.
    exclude: [...configDefaults.exclude, '.claude/**'],
    testTimeout: 15000,
  },
});
