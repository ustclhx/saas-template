import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'
import { devOnly } from '../../../server/dev-only.ts'

// 调试：向 EMAIL_QUEUE 投递一条消息，由 apps/jobs 的消费者处理（只打日志）。
export const Route = createFileRoute('/api/dev/email')({
  server: {
    handlers: {
      POST: () =>
        devOnly(async () => {
          const message = { type: 'debug', sentAt: new Date().toISOString() }
          await env.EMAIL_QUEUE.send(message)
          return Response.json({ queued: message })
        }),
    },
  },
})
