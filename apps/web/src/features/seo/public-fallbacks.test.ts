import { AppError } from '@saas/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-start', async (original) => {
  const actual = await original<typeof import('@tanstack/react-start')>()
  const createServerFn = () => {
    const builder = {
      middleware: () => builder,
      inputValidator: () => builder,
      handler: (handle: (options: unknown) => unknown) => (options?: unknown) =>
        handle(options ?? {}),
    }
    return builder
  }
  return { ...actual, createServerFn }
})
vi.mock('@saas/shared/log', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))

const state = vi.hoisted(() => ({
  runtime: undefined as unknown,
  stored: undefined as unknown,
  impersonation: vi.fn(),
}))
vi.mock('../../server/runtime.ts', async (original) => ({
  ...(await original<typeof import('../../server/runtime.ts')>()),
  getWebRuntime: () => {
    if (!state.runtime)
      throw new AppError('RUNTIME_UNAVAILABLE', 'Request runtime is unavailable', { status: 503 })
    return state.runtime
  },
}))
vi.mock('@saas/db', async (original) => ({
  ...(await original<typeof import('@saas/db')>()),
  dbSettingStore: () => ({ find: async () => state.stored }),
}))
vi.mock('../admin/impersonation.functions.ts', () => ({ getImpersonation: state.impersonation }))

import { log } from '@saas/shared/log'
import { getAnnouncement } from '../admin/settings-announcement.functions.ts'
import { getSafeImpersonation } from './origin.functions.ts'

const cache = (overrides: Partial<Record<'get' | 'put' | 'delete', unknown>> = {}) => ({
  get: vi.fn(async () => null),
  put: vi.fn(async () => undefined),
  delete: vi.fn(async () => undefined),
  ...overrides,
})

beforeEach(() => {
  vi.mocked(log.warn).mockClear()
  state.stored = undefined
  state.runtime = { db: {}, cache: cache() }
})

describe('公告读取降级（public-site-availability「运行时设置值损坏」）', () => {
  it('正常值原样返回', async () => {
    state.stored = 'Maintenance tonight'
    await expect(getAnnouncement()).resolves.toBe('Maintenance tonight')
  })

  it.each([
    [
      '数据库中的值不符合 schema',
      () => {
        state.stored = { not: 'a string' }
      },
    ],
    [
      'KV 缓存不是 JSON',
      () => {
        state.runtime = { db: {}, cache: cache({ get: vi.fn(async () => '{not json') }) }
      },
    ],
    [
      'KV 写入失败',
      () => {
        state.stored = 'Hello'
        state.runtime = {
          db: {},
          cache: cache({ put: vi.fn(async () => Promise.reject(new Error('KV PUT failed'))) }),
        }
      },
    ],
    [
      '没有请求 runtime（构建期预渲染）',
      () => {
        state.runtime = undefined
      },
    ],
  ])('%s 时按无公告处理并记警告', async (_name, arrange) => {
    arrange()
    await expect(getAnnouncement()).resolves.toBe('')
    expect(log.warn).toHaveBeenCalledWith('site.announcement_read_failed', expect.anything())
  })
})

describe('模拟登录读取降级', () => {
  it('会话读取的任何错误都按无模拟登录处理', async () => {
    for (const error of [
      new Error('connect ECONNREFUSED'),
      new AppError('CAPABILITY_UNAVAILABLE', 'Unavailable', { status: 503 }),
    ]) {
      state.impersonation.mockRejectedValueOnce(error)
      await expect(getSafeImpersonation()).resolves.toBeNull()
    }
    expect(log.warn).toHaveBeenCalledWith('site.impersonation_read_failed', expect.anything())
  })

  it('正常读取结果原样返回', async () => {
    const viewer = { userEmail: 'user@example.test', adminEmail: 'admin@example.test' }
    state.impersonation.mockResolvedValueOnce(viewer)
    await expect(getSafeImpersonation()).resolves.toEqual(viewer)
  })
})
