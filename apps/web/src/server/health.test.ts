import { type Database, pingDatabase } from '@saas/db'
import { beforeEach, expect, it, vi } from 'vitest'
import { healthResponse } from './health.ts'

vi.mock('@saas/db', () => ({
  pingDatabase: vi.fn(),
  readLastCronAt: async () => null,
}))
vi.mock('@saas/shared/log', () => ({ log: { error: vi.fn() } }))

beforeEach(() => {
  vi.mocked(pingDatabase).mockReset()
})

it.each([200, 503])('%s 响应原样返回构建提交标识', async (status) => {
  if (status === 503) vi.mocked(pingDatabase).mockRejectedValue(new Error('unavailable'))
  const version = 'abcdef0123456789abcdef0123456789abcdef0123'
  const response = await healthResponse({
    database: () => ({}) as Database,
    version,
  })
  expect(response.status).toBe(status)
  expect(await response.json()).toMatchObject({ version })
})

it('数据库初始化失败也返回脱敏 503 与版本', async () => {
  const response = await healthResponse({
    database: () => {
      throw new Error('postgres://private-host:secret')
    },
    version: 'build-sha',
  })
  expect(response.status).toBe(503)
  expect(await response.json()).toEqual({
    status: 'error',
    version: 'build-sha',
    db: { status: 'down' },
  })
})
