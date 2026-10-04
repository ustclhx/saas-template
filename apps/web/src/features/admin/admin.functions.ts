import { env } from 'cloudflare:workers'
import { createDb } from '@saas/db'
import { notFound } from '@tanstack/react-router'
import { createMiddleware, createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { getAuth } from '../../server/auth.ts'
import { isAdminNotFound, requireAdmin } from './guard.ts'

/**
 * `/admin` 下所有 server function 都必须挂这个中间件（路由的 `beforeLoad` 只管页面，
 * server function 可以被直接调用）。不满足条件时抛出路由的 notFound，页面与直接调用都得到 404。
 */
export const adminMiddleware = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  const db = createDb(env.HYPERDRIVE)
  const admin = await requireAdmin({
    auth: getAuth(env, db),
    db,
    headers: getRequest().headers,
  }).catch((error: unknown) => {
    if (isAdminNotFound(error)) throw notFound()
    throw error
  })
  return next({ context: { admin: admin.user, db } })
})

/** 后台布局使用的当前管理员信息 */
export const getAdminViewer = createServerFn({ method: 'GET' })
  .middleware([adminMiddleware])
  .handler(({ context }) => ({
    id: context.admin.id,
    name: context.admin.name,
    email: context.admin.email,
  }))
