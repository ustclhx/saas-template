// 举报对话框打开时读取：作品页 HTML 对匿名访客走边缘缓存，登录状态只能在打开对话框时向服务端询问。
// 判定与举报接口（routes/api/studio/reports.ts）一致：会话以数据库为准，Turnstile 需模板开关与 site key 同时开启。
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

export const getStudioReportContext = createServerFn({ method: 'GET' }).handler(async () => {
  const [{ getWebRuntime }, { templateConfig }, { requireFreshSession }, { hasSessionCookie }] =
    await Promise.all([
      import('@web/server/runtime.ts'),
      import('@web/server/template-config.ts'),
      import('@saas/auth'),
      import('./page-cache.ts'),
    ])
  const runtime = getWebRuntime()
  const headers = getRequest().headers
  let signedIn = false
  // 没有会话 Cookie 时不查库
  if (hasSessionCookie(headers.get('cookie'))) {
    try {
      await requireFreshSession({ auth: runtime.auth, db: runtime.db, headers })
      signedIn = true
    } catch {
      signedIn = false
    }
  }
  const turnstileSiteKey =
    templateConfig.auth.turnstile && runtime.config.TURNSTILE_SITE_KEY
      ? runtime.config.TURNSTILE_SITE_KEY
      : null
  // 未配置 Turnstile 时匿名举报关闭（design 决策 9），只允许登录用户举报
  return { signedIn, turnstileSiteKey }
})

export type StudioReportContext = Awaited<ReturnType<typeof getStudioReportContext>>
