import { env } from 'cloudflare:workers'
import { createDb } from '@saas/db'
import {
  createCloudflareBackgroundTasks,
  createCloudflareRateLimiter,
} from '@saas/platform/cloudflare'
import { registerAiChatSuite } from './fixtures/ai-chat.suite.ts'

registerAiChatSuite(createDb(env.HYPERDRIVE), {
  rateLimiter: createCloudflareRateLimiter({ RL_AI: { limit: async () => ({ success: true }) } }),
  background: () => {
    const promises: Promise<unknown>[] = []
    return {
      ...createCloudflareBackgroundTasks({
        waitUntil: (promise) => {
          promises.push(promise)
        },
      }),
      settled: () => Promise.all(promises),
    }
  },
})
