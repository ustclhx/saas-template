// 举报对话框打开时读取：作品页 HTML 对匿名访客走边缘缓存，登录状态只能在打开对话框时向服务端询问。
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

export const getStudioReportContext = createServerFn({ method: 'GET' }).handler(async () => {
  const [{ getWebRuntime }, { readRequestSession }, { hasSessionCookie }] = await Promise.all([
    import('@web/server/runtime.ts'),
    import('@web/features/i18n/session.server.ts'),
    import('./page-cache.ts'),
  ])
  const runtime = getWebRuntime()
  const request = getRequest()
  let signedIn = false
  if (hasSessionCookie(request.headers.get('cookie'))) {
    try {
      await readRequestSession({ auth: runtime.auth, db: runtime.db, headers: request.headers })
      signedIn = true
    } catch {
      signedIn = false
    }
  }
  // 未配置 Turnstile 时匿名举报关闭（design 决策 9），只允许登录用户举报
  return { signedIn, turnstileSiteKey: runtime.config.TURNSTILE_SITE_KEY || null }
})

export type StudioReportContext = Awaited<ReturnType<typeof getStudioReportContext>>
