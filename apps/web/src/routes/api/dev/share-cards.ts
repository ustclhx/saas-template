import { createFileRoute } from '@tanstack/react-router'
import { devOnly } from '../../../server/dev-only.ts'

// 调试与 e2e：登记内存中的示例分享、调用失效函数（features/share-cards/preview.server.ts）。
export const Route = createFileRoute('/api/dev/share-cards')({
  server: {
    handlers: {
      POST: ({ request }) =>
        devOnly(async () =>
          (
            await import('../../../features/share-cards/preview.server.ts')
          ).handleSampleShareFixture(request),
        ),
    },
  },
})
