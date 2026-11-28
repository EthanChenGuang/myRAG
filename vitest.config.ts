import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    setupFiles: ['tests/setup-env.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
    // Route-fixture setup builds the full fixture corpus; with the 05.2.1-12 documents a multi-tenant build takes 43-59 s on CI.
    hookTimeout: 180000,
  },
});
