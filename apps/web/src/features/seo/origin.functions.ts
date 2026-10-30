import { plausibleSite } from '@saas/config'
import { log } from '@saas/shared/log'
import { createServerFn } from '@tanstack/react-start'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'
import { getImpersonation } from '../admin/impersonation.functions.ts'

export const getSeoOrigin = createServerFn({ method: 'GET' }).handler(
  () => getWebRuntime().config.APP_URL,
)

/** 按环境取值：同一套代码在 staging 与生产注入各自的 site，绝不写进构建常量。 */
export const getPlausibleSite = createServerFn({ method: 'GET' }).handler(() => {
  const site = plausibleSite(templateConfig.features.analytics, getWebRuntime().config)
  return site && { domain: site.domain, scriptUrl: site.scriptUrl }
})

/** 根布局中的会话装饰读取失败不能阻断公开页（无数据库预渲染）。 */
export const getSafeImpersonation = createServerFn({ method: 'GET' }).handler(async () => {
  try {
    return await getImpersonation()
  } catch (error) {
    log.warn('site.impersonation_read_failed', { error })
    return null
  }
})
