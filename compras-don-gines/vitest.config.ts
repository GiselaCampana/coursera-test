import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Las pruebas de integración comparten una única base: sin paralelismo
    // entre archivos no hay carreras al truncar tablas.
    fileParallelism: false,
    globalSetup: ['./tests/integration/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // `server-only` existe para que el bundler falle si un módulo de
      // servidor entra al cliente. Fuera de Next no hace falta y sólo tira.
      'server-only': path.resolve(__dirname, './tests/stubs/server-only.ts'),
    },
  },
});
