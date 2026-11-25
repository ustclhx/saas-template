import {
  createPaymentRuntime,
  notifyRefundRequest,
  type RefundServiceOptions,
  reviewRefundRequest,
} from '@saas/billing'
import type { Database } from '@saas/db'
import { requireCapability } from '@saas/platform'
import { AppError } from '@saas/shared'
import { withRequestId } from '@saas/shared/log'
import { setResponseStatus } from '@tanstack/react-start/server'
import { getWebRuntime } from '../../server/runtime.ts'
import { templateConfig } from '../../server/template-config.ts'

// 后台退款与回调重放使用的支付运行时与退款服务选项。后台退款页与 admin-mcp 的确认执行
// （退款审核经管理员确认后执行，add-admin-step-up 任务 3.4）共用，只能在 server function handler 内调用。

export function adminPaymentRuntime(db: Database) {
  try {
    return createPaymentRuntime(getWebRuntime().config, templateConfig.billing.providers, {
      cache: getWebRuntime().cache,
      db,
    })
  } catch (error) {
    if (error instanceof AppError && error.status === 503) setResponseStatus(503)
    throw error
  }
}
export function adminRefundOptions(db: Database): RefundServiceOptions {
  const queue = requireCapability(getWebRuntime().emailQueue, 'Email queue')
  return {
    db,
    providers: adminPaymentRuntime(db).providers,
    config: templateConfig.billing,
    notify: (notification) =>
      notifyRefundRequest(
        {
          db,
          queue: {
            send: async (message) => {
              await queue.send(withRequestId(message))
            },
          },
          appName: templateConfig.app.name,
          supportEmail: templateConfig.app.supportEmail,
        },
        notification,
      ),
  }
}

/** 后台退款审核（含确认执行 AI 发起的审核）：插件经此调用，不直接依赖 @saas/billing */
export function reviewAdminRefundRequest(
  db: Database,
  input: Parameters<typeof reviewRefundRequest>[1],
) {
  return reviewRefundRequest(adminRefundOptions(db), input)
}
