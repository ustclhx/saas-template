import { createAdminStepUp, type StepUpVerified } from '@saas/auth'
import { requireCapability } from '@saas/platform'
import { log } from '@saas/shared/log'
import { createQueueAuthEmailSender, userLocaleByEmail } from '../../../server/auth-email.ts'
import type { WebRuntime } from '../../../server/runtime.ts'
import { templateConfig } from '../../../server/template-config.ts'
import { enqueueOperations } from '../../notifications/operations.ts'
import { stepUpRescueConfig } from './check.ts'

// 后台重新验证服务的 web 装配（add-admin-step-up tasks 2.2 / 2.3）。只在 server function 的
// handler 内引用：会把 @saas/db 与认证密钥配置带进来。

export async function createWebStepUp(runtime: WebRuntime) {
  // 与 Better Auth 2FA 插件用同一份密钥配置解密 two_factor 行
  const { secretConfig } = await runtime.auth.$context
  return createAdminStepUp({
    db: runtime.db,
    secretConfig,
    stepUpMinutes: templateConfig.admin.stepUpMinutes,
    rateLimiter: runtime.rateLimiter,
    clientIp: runtime.requestMeta.clientIp,
    rescue: stepUpRescueConfig(runtime.config),
    sendEmail: (email) => {
      // 与认证邮件的本地调试一致（server.ts）：开发环境打印邮件，e2e 夹具从日志取验证码；生产不写日志
      if (import.meta.env.DEV) console.log('[dev] auth email', email)
      return createQueueAuthEmailSender({
        queue: requireCapability(runtime.emailQueue, 'Email queue'),
        appName: templateConfig.app.name,
        appUrl: runtime.config.APP_URL,
        resolveLocale: userLocaleByEmail(runtime.db),
      })(email)
    },
  })
}

/** 救援验证成功后投递运营通知；业务已提交，投递失败只记日志（与其他运营事件一致） */
export async function notifyRescue(runtime: WebRuntime, verified: StepUpVerified) {
  if (verified.method !== 'rescue') return
  const events = runtime.eventsQueue
  if (!events.available) {
    log.warn('operations.enqueue_failed', {
      event: 'admin.step_up.rescue',
      sourceId: verified.auditId,
    })
    return
  }
  await enqueueOperations(
    { send: (message) => events.value.send(message) },
    { event: 'admin.step_up.rescue', sourceId: verified.auditId },
  )
}
