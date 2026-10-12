import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['test/node-production.integration.test.ts'], testTimeout: 15_000 },
})
