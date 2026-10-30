import type { Database } from '@saas/db'
import { userAttribution } from '@saas/db'
import type { QueueProducer } from '@saas/platform'
import {
  FIRST_TOUCH_COOKIE,
  parseFirstTouch,
  readCookie,
  type ServerAnalyticsEvent,
} from '@saas/shared/analytics'
import { log, withRequestId } from '@saas/shared/log'
import { templateConfig } from '../../server/template-config.ts'

type EventsQueue = Pick<QueueProducer<unknown>, 'send'>

/** 业务已提交后才投递；失败只记日志，付款与注册的真相仍在数据库。 */
export async function enqueueServerAnalytics(
  queue: EventsQueue | undefined,
  analytics: ServerAnalyticsEvent,
) {
  if (!queue || templateConfig.features.analytics === false) return
  try {
    await queue.send(withRequestId({ v: 1, analytics }))
  } catch {
    log.warn('analytics.enqueue_failed', { event: analytics.event })
  }
}

/** 注册入口统一经 Better Auth 钩子（邮箱、OTP、魔法链接、OAuth 回调都带同站 Cookie）。 */
export function createSignUpRecorder(options: {
  db: Database
  queue: EventsQueue | undefined
  clientIp?: string | null | undefined
}) {
  return async (user: { readonly id: string }, headers?: Headers) => {
    if (templateConfig.features.analytics === false) return
    const touch = parseFirstTouch(readCookie(headers?.get('cookie'), FIRST_TOUCH_COOKIE))
    if (touch) {
      await options.db
        .insert(userAttribution)
        .values({
          userId: user.id,
          source: touch.source,
          medium: touch.medium,
          campaign: touch.campaign,
          term: touch.term,
          content: touch.content,
          referrerHost: touch.referrerHost,
          landingPath: touch.landingPath,
          device: touch.device,
          firstSeenAt: new Date(touch.firstSeenAt),
        })
        .onConflictDoNothing()
    }
    const userAgent = headers?.get('user-agent')
    await enqueueServerAnalytics(options.queue, {
      event: 'sign_up',
      userId: user.id,
      ...(options.clientIp ? { clientIp: options.clientIp } : {}),
      ...(userAgent ? { userAgent } : {}),
    })
  }
}
