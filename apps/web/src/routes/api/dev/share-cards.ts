import { createFileRoute } from '@tanstack/react-router'

// e2e 与 staging 验收夹具：登记内存中的示例分享、调用失效函数。仅 UI_PREVIEW=true 且平台管理员会话可用，
// 其余 404（features/share-cards/preview.server.ts）。
export const Route = createFileRoute('/api/dev/share-cards')({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await import('../../../features/share-cards/preview.server.ts')).handleSampleShareFixture(
          request,
        ),
    },
  },
})
