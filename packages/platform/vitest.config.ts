import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'node', include: ['test/node.test.ts'] } },
      {
        plugins: [
          cloudflareTest({
            remoteBindings: false,
            wrangler: { configPath: './test/wrangler.jsonc' },
          }),
        ],
        test: { name: 'cloudflare', include: ['test/cloudflare.test.ts'] },
      },
    ],
  },
})
