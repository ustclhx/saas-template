import { env } from 'cloudflare:workers'
import { requireFreshSession } from '@saas/auth'
import { listDeletionRefundReminders } from '@saas/billing'
import { createDb } from '@saas/db'
import { AppError } from '@saas/shared'
import { redirect } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { getAuth } from '../../server/auth.ts'
import { templateConfig } from '../../server/template-config.ts'
import { loadAccount } from './account.ts'

/** 未登录时跳转的登录页（/login 由认证页面提供，登录后回到 /account） */
export const ACCOUNT_LOGIN_HREF = `/login?redirect=${encodeURIComponent('/account')}`

/**
 * 设置页数据：会话与封禁状态以数据库为准（requireFreshSession），未登录或已失效时跳转登录页。
 * 修改操作直接调用 Better Auth 的接口（/api/auth/*），其中修改密码、两步验证同样按数据库实时校验。
 */
export const getAccount = createServerFn({ method: 'GET' }).handler(async () => {
  const db = createDb(env.HYPERDRIVE)
  const auth = getAuth(env, db)
  try {
    const { user } = await requireFreshSession({ auth, db, headers: getRequest().headers })
    const reminders = await listDeletionRefundReminders(
      { db, actorUserId: user.id, workspaceIds: [user.id] },
      templateConfig.billing.refundWindowDays,
    )
    const personal = await db.query.organization.findFirst({
      where: (o, { eq }) => eq(o.id, user.id),
      columns: { slug: true },
    })
    return {
      deletionRefunds: {
        eligibleCount: reminders.eligiblePaymentIds.length,
        pendingCount: reminders.pendingRequests.length,
        billingHref: personal ? `/app/${personal.slug}/billing` : '/app',
      },
      ...(await loadAccount(db, user, templateConfig)),
      supportEmail: templateConfig.app.supportEmail,
      signupBonusCredits: templateConfig.billing.signupBonusCredits,
    }
  } catch (error) {
    if (error instanceof AppError) throw redirect({ href: ACCOUNT_LOGIN_HREF })
    throw error
  }
})
