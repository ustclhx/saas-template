import { createFileRoute } from '@tanstack/react-router'

/** 做同款（openspec add-media-studio 6.2）：未登录先去登录并回到这里；登录后进入默认空间的创作页并预填模型与公开的提示词 */
export const Route = createFileRoute('/gallery/remix/$slug')({
  server: {
    handlers: {
      GET: async ({ request, params }) =>
        (await import('../../src/web/gallery/remix.server.ts')).handleRemix(request, params.slug),
    },
  },
})
