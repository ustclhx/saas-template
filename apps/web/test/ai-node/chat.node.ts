import { createDb } from '@saas/db'
import { createNodeBackgroundTasks } from '@saas/platform/node'
import { afterAll, expect } from 'vitest'
import { registerAiChatSuite } from '../fixtures/ai-chat.suite.ts'

const databaseUrl = process.env.NODE_AI_DATABASE_URL
if (!databaseUrl) throw new Error('Missing Node AI database URL')
const db = createDb(databaseUrl, { max: 3 })
afterAll(() => db.close())
// 复用业务用例及真实 Node 后台排空；模型模拟不代替组 6 的 direct/Gateway 或生产 HTTP 验收。
registerAiChatSuite(db, {
  rateLimiter: { limit: async () => ({ success: true }) },
  background: () => {
    const tasks = createNodeBackgroundTasks()
    return {
      ...tasks,
      settled: async () => {
        expect(await tasks.drain(5000)).toEqual({
          completed: true,
          pendingTasks: 0,
          activeRequests: 0,
        })
      },
    }
  },
})
