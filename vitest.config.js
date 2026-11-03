import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // next/ is a separate package with its own dependencies and test config
    // (cd next && npm test); worktrees carry their own copies of every test.
    exclude: [...configDefaults.exclude, 'next/**', '.claude/**'],
  },
});
