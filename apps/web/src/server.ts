// Worker 入口（wrangler.jsonc 的 main）。
// 在交给 TanStack Start 处理之前校验环境变量与绑定，缺失或非法时任何请求都返回 500。
import handler from '@tanstack/react-start/server-entry'
import { checkEnv } from './server/env.ts'

export default {
  async fetch(request, env) {
    return checkEnv(env) ?? (await handler.fetch(request))
  },
} satisfies ExportedHandler<Cloudflare.Env>
