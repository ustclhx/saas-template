import { describe, expect, it } from 'vitest'
import type { WebRuntime } from '../../server/runtime.ts'
import { gateAdminRequest, isGatedAdminPath } from './gate.ts'

// 读取 db / auth 即失败：未命中守卫的路径不得触碰认证与数据库
const runtime = new Proxy({} as WebRuntime, {
  get(_target, key) {
    throw new Error(`runtime.${String(key)} must not be read`)
  },
})

describe('admin 门禁只匹配 /admin 与 /admin/…（public-site-availability）', () => {
  it.each(['/admin', '/admin/users', '/admin/settings/announcement'])('%s 受守卫', (path) => {
    expect(isGatedAdminPath(path)).toBe(true)
  })

  // /zh/admin 的语言前缀由语言守卫与路由自身的 beforeLoad 处理，不在此处查库
  it.each(['/administrator', '/admin-x', '/zh/admin', '/blog/admin', '/admin/'])(
    '%s 不受守卫，也不读取会话或数据库',
    async (path) => {
      expect(isGatedAdminPath(path)).toBe(false)
      const request = new Request(`https://example.test${path}`)
      await expect(gateAdminRequest(request, runtime)).resolves.toBe(request)
    },
  )
})
