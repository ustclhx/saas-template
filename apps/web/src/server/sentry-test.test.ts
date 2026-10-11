import { AppError } from '@saas/shared'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ admin: vi.fn(), audit: vi.fn(), enabled: true }))
vi.mock('@saas/db', () => ({ createDb: () => ({}) }))
vi.mock('./auth.ts', () => ({ getAuth: () => ({}) }))
vi.mock('./sentry.ts', () => ({ sentryEnabled: () => mocks.enabled }))
vi.mock('../features/admin/guard.ts', () => ({
  requireAdmin: mocks.admin,
  isAdminNotFound: (error: unknown) => error instanceof AppError && error.status === 404,
}))
vi.mock('../features/admin/action.server.ts', () => ({
  withAdminAction: async (
    _context: unknown,
    _name: string,
    handler: (scope: unknown) => Promise<void>,
  ) => {
    await handler({ audit: mocks.audit })
  },
}))

import { SENTRY_TEST_PATH, sentryTest } from './sentry-test.ts'

const env = { APP_URL: 'https://app.test' } as Cloudflare.Env
const request = (origin = env.APP_URL) =>
  new Request(`${env.APP_URL}${SENTRY_TEST_PATH}`, {
    method: 'POST',
    headers: { origin },
  })
afterEach(() => {
  vi.clearAllMocks()
  mocks.enabled = true
})

it('外站与非管理员不能触发异常或审计', async () => {
  expect((await sentryTest(request('https://attacker.test'), env)).status).toBe(403)
  expect(mocks.admin).not.toHaveBeenCalled()
  mocks.admin.mockRejectedValueOnce(new AppError('NOT_FOUND', 'Not Found', { status: 404 }))
  expect((await sentryTest(request(), env)).status).toBe(404)
  expect(mocks.audit).not.toHaveBeenCalled()
})

it('管理员触发前提交审计，未启用时不抛测试异常', async () => {
  mocks.admin.mockResolvedValue({ user: { id: 'admin-1' } })
  mocks.enabled = false
  expect((await sentryTest(request(), env)).status).toBe(503)
  expect(mocks.audit).not.toHaveBeenCalled()
  mocks.enabled = true
  await expect(sentryTest(request(), env)).rejects.toThrow(
    'Sentry verification: web worker test exception',
  )
  expect(mocks.audit).toHaveBeenCalledWith({
    action: 'observability.sentry-test',
    targetType: 'observability',
  })
})
