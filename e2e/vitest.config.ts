// Integration tests against the docker test servers: pnpm exec vitest run -c e2e/vitest.config.ts
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, '../src/shared') } },
  test: { root: __dirname, include: ['**/*.test.ts'], fileParallelism: false, testTimeout: 30000 }
})
