import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * La suite de rendimiento, aparte de la funcional.
 *
 * Mide tiempo de pared, así que depende de la máquina que la corre: en un
 * runner compartido raspa el presupuesto y a veces lo pasa. Eso informa, no
 * bloquea, y por eso tiene su propia configuración y su propio trabajo de CI.
 *
 * No levanta la base: lo que mide se calcula sobre evidencia guardada, sin
 * Postgres de por medio, así que no hace falta el `globalSetup` de integración.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/rendimiento/**/*.perf.test.ts'],
    globals: false,
    testTimeout: 120_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      'server-only': path.resolve(__dirname, './tests/stubs/server-only.ts'),
    },
  },
});
