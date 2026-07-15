import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: '../../node_modules/.vitest-actions',
  test: {
    include: ['**/*.spec.mjs'],
    exclude: ['classify-mobile-release/**/*.spec.mjs'],
    environment: 'node',
    root: import.meta.dirname,
  },
});
