import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineSetting } from './setting-definition.ts'
import {
  getSetting,
  getSettingDefinition,
  getSettingValue,
  listSettingDefinitions,
  registerSettingDefinitions,
  resetInvalidSettingWarnings,
  resolveStoredSetting,
  SETTING_CACHE_TTL_SECONDS,
  type SettingCache,
  type SettingStore,
  settingDefaults,
  validateSettingValue,
} from './settings.ts'

vi.mock('./settings.project.ts', async () => {
  const { z } = await import('zod')
  const { defineSetting } = await import('./setting-definition.ts')
  return {
    default: {
      'project.reportPrice': defineSetting({
        schema: z.number().int().nonnegative(),
        default: 25,
        description: '报告积分价格',
      }),
    },
  }
})

function memoryStore(rows: Readonly<Record<string, unknown>>) {
  const calls: string[] = []
  const store: SettingStore = {
    async find(key) {
      calls.push(key)
      return rows[key]
    },
  }
  return { store, calls }
}

function memoryCache() {
  const data = new Map<string, string>()
  const ttls: (number | undefined)[] = []
  const cache: SettingCache = {
    async get(key) {
      return data.get(key) ?? null
    },
    async put(key, value, options) {
      data.set(key, value)
      ttls.push(options?.expirationTtl)
    },
  }
  return { cache, data, ttls }
}

describe('运行时设置定义', () => {
  it('按键及列表返回定义元数据和可用的 JSON Schema', () => {
    const amount = getSettingDefinition('credits.dailyAmount')
    expect(amount).toMatchObject({
      key: 'credits.dailyAmount',
      description: expect.any(String),
      secret: false,
      default: 10,
      jsonSchema: { type: 'integer', minimum: 1, maximum: 2147483647 },
    })
    expect(listSettingDefinitions()).toContain(amount)
    expect(getSettingDefinition('operations.telegramBotToken')?.secret).toBe(true)
    expect(getSettingDefinition('operations.discordWebhookUrl')?.secret).toBe(true)
    for (const definition of listSettingDefinitions()) expect(definition.jsonSchema).toBeDefined()
  })

  it('从项目自有文件读取设置的默认值并校验写入值', async () => {
    const key = 'project.reportPrice'
    const { store } = memoryStore({})
    expect(await getSettingValue({ store }, key)).toBe(25)
    expect(validateSettingValue(key, 10)).toBe(10)
    expect(() => validateSettingValue(key, -1)).toThrow('Invalid runtime setting')
    expect(() => validateSettingValue('project.typo', 10)).toThrow('Unknown runtime setting')
  })

  it('重复键使整批登记失败，保留原有定义', () => {
    const definition = defineSetting({ schema: z.boolean(), default: false, description: 'Test' })
    expect(() =>
      registerSettingDefinitions({
        'project.unregistered': definition,
        'auth.signupEnabled': definition,
      }),
    ).toThrow('Duplicate runtime setting: auth.signupEnabled')
    expect(getSettingDefinition('project.unregistered')).toBeUndefined()
    expect(getSettingDefinition('auth.signupEnabled')?.default).toBe(true)
  })

  it('拒绝不受信任的 Discord Webhook 地址', () => {
    expect(() => validateSettingValue('operations.discordWebhookUrl', 'http://127.0.0.1/')).toThrow(
      'Invalid runtime setting',
    )
  })
})

// 读取回落时写 console.warn 结构化日志；每个用例重置「每键一次」的记录
// db 包不引入 DOM / Node 全局类型，经 globalThis 取 console
const warn = vi
  .spyOn((globalThis as unknown as { console: { warn(line: string): void } }).console, 'warn')
  .mockImplementation(() => {})
beforeEach(() => {
  resetInvalidSettingWarnings()
  warn.mockClear()
})
afterEach(() => warn.mockClear())

describe('getSetting', () => {
  it('表中存在时返回表中的值', async () => {
    const { store } = memoryStore({ 'auth.signupEnabled': false })
    expect(await getSetting({ store }, 'auth.signupEnabled')).toBe(false)
  })

  it('表中缺失时回退到代码默认值', async () => {
    const { store } = memoryStore({})
    expect(await getSetting({ store }, 'auth.signupEnabled')).toBe(
      settingDefaults['auth.signupEnabled'],
    )
    expect(settingDefaults['auth.signupEnabled']).toBe(true)
  })

  it('媒体不确定提交默认等待 1 小时', async () => {
    const { store } = memoryStore({})
    expect(await getSetting({ store }, 'ai.mediaUncertainWaitSeconds')).toBe(3600)
  })

  it('数据库值不符合定义时回落默认值，缓存原值，告警只含键名且每键一次', async () => {
    const { store } = memoryStore({ 'site.announcement': false })
    const { cache, data } = memoryCache()
    expect(await getSetting({ store, cache }, 'site.announcement')).toBe('')
    expect(await getSetting({ store, cache }, 'site.announcement')).toBe('')
    expect(data.get('setting:site.announcement')).toBe('{"v":false}')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      level: 'warn',
      event: 'runtime_setting.invalid_stored_value',
      key: 'site.announcement',
      scope: 'global',
      fallback: 'default',
    })
  })

  it('密钥项的非法值不进入告警', async () => {
    const secret = 'not-a-telegram-token'
    const { store } = memoryStore({ 'operations.telegramBotToken': secret })
    expect(await getSetting({ store }, 'operations.telegramBotToken')).toBe('')
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).not.toContain(secret)
  })

  it('resolveStoredSetting 区分表中值、缺失与回落', () => {
    expect(resolveStoredSetting('auth.signupEnabled', false)).toEqual({
      value: false,
      source: 'database',
    })
    expect(resolveStoredSetting('auth.signupEnabled', undefined)).toEqual({
      value: true,
      source: 'default',
    })
    expect(resolveStoredSetting('auth.signupEnabled', 'false')).toEqual({
      value: true,
      source: 'fallback',
    })
    expect(() => resolveStoredSetting('project.typo', 1)).toThrow('Unknown runtime setting')
  })

  it('表中存在时写入缓存，之后命中缓存不再查表', async () => {
    const { store, calls } = memoryStore({ 'auth.signupEnabled': false })
    const { cache, data, ttls } = memoryCache()
    expect(await getSetting({ store, cache }, 'auth.signupEnabled')).toBe(false)
    expect(await getSetting({ store, cache }, 'auth.signupEnabled')).toBe(false)
    expect(calls).toEqual(['auth.signupEnabled'])
    expect(data.get('setting:auth.signupEnabled')).toBe('{"v":false}')
    expect(ttls).toEqual([SETTING_CACHE_TTL_SECONDS])
  })

  it('表中缺失的结果也缓存，命中时仍回退到默认值', async () => {
    const { store, calls } = memoryStore({})
    const { cache, data } = memoryCache()
    expect(await getSetting({ store, cache }, 'auth.signupEnabled')).toBe(true)
    expect(await getSetting({ store, cache }, 'auth.signupEnabled')).toBe(true)
    expect(calls).toEqual(['auth.signupEnabled'])
    expect(data.get('setting:auth.signupEnabled')).toBe('{}')
  })
})

describe('ai.freeFailures', () => {
  it('默认每小时 3 次免费失败', async () => {
    const { store } = memoryStore({})
    expect(await getSetting({ store }, 'ai.freeFailures')).toEqual({
      count: 3,
      windowSeconds: 3600,
    })
  })

  it('表中保存的值覆盖默认值', async () => {
    const { store } = memoryStore({ 'ai.freeFailures': { count: 0, windowSeconds: 600 } })
    expect(await getSetting({ store }, 'ai.freeFailures')).toEqual({ count: 0, windowSeconds: 600 })
  })
})

describe('每日赠送设置读取边界', () => {
  it('缺失时使用数量、月天数、有效期及邮箱验证默认值', async () => {
    const { store } = memoryStore({})
    expect(await getSetting({ store }, 'credits.dailyAmount')).toBe(10)
    expect(await getSetting({ store }, 'credits.dailyMaxDaysPerMonth')).toBe(10)
    expect(await getSetting({ store }, 'credits.dailyExpiryDays')).toBe(7)
    expect(await getSetting({ store }, 'credits.dailyRequireVerifiedEmail')).toBe(true)
  })

  it('接受合法上界与显式关闭邮箱验证', async () => {
    const { store } = memoryStore({
      'credits.dailyAmount': 2147483647,
      'credits.dailyMaxDaysPerMonth': 31,
      'credits.dailyExpiryDays': 365,
      'credits.dailyRequireVerifiedEmail': false,
    })
    for (const key of [
      'credits.dailyAmount',
      'credits.dailyMaxDaysPerMonth',
      'credits.dailyExpiryDays',
      'credits.dailyRequireVerifiedEmail',
    ] as const) {
      expect(await getSetting({ store }, key)).toEqual(await store.find(key))
    }
  })

  it.each([
    ['credits.dailyAmount', 0],
    ['credits.dailyAmount', 2147483648],
    ['credits.dailyAmount', 1.5],
    ['credits.dailyAmount', '10'],
    ['credits.dailyMaxDaysPerMonth', 32],
    ['credits.dailyExpiryDays', 366],
    ['credits.dailyRequireVerifiedEmail', 'false'],
  ] as const)('数据库与缓存中的非法设置 %s=%s 回落默认值', async (key, value) => {
    const { store } = memoryStore({ [key]: value })
    expect(await getSetting({ store }, key)).toBe(settingDefaults[key])
    const { cache, data } = memoryCache()
    data.set(`setting:${key}`, JSON.stringify({ v: value }))
    expect(await getSetting({ store: memoryStore({}).store, cache }, key)).toBe(
      settingDefaults[key],
    )
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
