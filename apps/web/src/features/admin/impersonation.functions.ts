import { env } from 'cloudflare:workers'
import { requireFreshSession } from '@saas/auth'
import { createDb } from '@saas/db'
import { AppError } from '@saas/shared'
import { createServerFn } from '@tanstack/react-start'
import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import { getAuth } from '../../server/auth.ts'
import { executeAdminAuthAction } from './impersonation.server.ts'

export const getImpersonation = createServerFn({ method: 'GET' }).handler(async () => {
  const db = createDb(env.HYPERDRIVE)
  try {
    const fresh = await requireFreshSession({
      auth: getAuth(env, db),
      db,
      headers: getRequest().headers,
    })
    const adminId = fresh.session.impersonatedBy
    if (!adminId) return null
    const admin = await db.query.user.findFirst({
      where: (u, { eq }) => eq(u.id, adminId),
    })
    return { userEmail: fresh.user.email, adminEmail: admin?.email ?? adminId }
  } catch (error) {
    if (error instanceof AppError && [401, 403].includes(error.status)) return null
    throw error
  }
})

export const stopAdminImpersonation = createServerFn({ method: 'POST' }).handler(async () => {
  const response = await executeAdminAuthAction({
    db: createDb(env.HYPERDRIVE),
    env,
    headers: getRequest().headers,
    path: '/admin/stop-impersonating',
  })
  setResponseHeader('set-cookie', response.headers.getSetCookie())
  return { ok: true }
})
