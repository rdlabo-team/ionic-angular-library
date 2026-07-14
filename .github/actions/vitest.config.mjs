import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '../../node_modules/.vitest-actions',
  test: {
    include: ['**/*.spec.mjs'],
    environment: 'node',
    root: import.meta.dirname,
  },
});
