import { createDb } from '@saas/db'
import { setLogContext } from '@saas/shared/log'
import { withAdminAction } from '../features/admin/action.server.ts'
import { isAdminNotFound, requireAdmin } from '../features/admin/guard.ts'
import { getAuth } from './auth.ts'
import { sentryEnabled } from './sentry.ts'

export const SENTRY_TEST_PATH = '/api/admin/observability/sentry-test'

/** 只允许同源 POST 与实时平台管理员会话；审计先提交，再抛出异常供 Worker 包装器采集。 */
export async function sentryTest(request: Request, env: Cloudflare.Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Not Found', { status: 404 })
  if (request.headers.get('origin') !== new URL(env.APP_URL).origin)
    return new Response('Forbidden', { status: 403 })
  const db = createDb(env.HYPERDRIVE)
  let fresh: Awaited<ReturnType<typeof requireAdmin>>
  try {
    fresh = await requireAdmin({ auth: getAuth(env, db), db, headers: request.headers })
  } catch (error) {
    if (isAdminNotFound(error)) return new Response('Not Found', { status: 404 })
    throw error
  }
  if (!sentryEnabled(env)) return new Response('Sentry disabled', { status: 503 })
  setLogContext({ userId: fresh.user.id })
  await withAdminAction(
    { db, admin: fresh.user, ip: request.headers.get('cf-connecting-ip') },
    'observability.sentry-test',
    async ({ audit }) => {
      await audit({ action: 'observability.sentry-test', targetType: 'observability' })
    },
  )
  throw new Error('Sentry verification: web worker test exception')
}
