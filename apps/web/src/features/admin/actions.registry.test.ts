import type { Database } from '@saas/db'
import { describe, expect, it } from 'vitest'
import {
  adminActions,
  defineAdminActions,
  getAdminActionDefinition,
  requiresStepUp,
} from './actions.registry.ts'

// add-admin-step-up tasks.md 1.1：动作登记表与按输入判定。

/** 只实现判定函数用到的查询链：select().from().where()[.limit()] 返回给定行 */
function fakeDb(rows: unknown[]): Database {
  const where = () => Object.assign(Promise.resolve(rows), { limit: async () => rows })
  return { select: () => ({ from: () => ({ where }) }) } as unknown as Database
}

const TOKEN = `123456:${'a'.repeat(30)}`

describe('defineAdminActions', () => {
  it('返回可直接传给包装的动作名，并登记判定规则', () => {
    const actions = defineAdminActions('registry-test-a', {
      'registry-test.write': { stepUp: 'always', reason: '测试' },
    })
    expect(actions['registry-test.write']).toBe('registry-test.write')
    expect(getAdminActionDefinition('registry-test.write')?.stepUp).toBe('always')
  })

  it('与模板或其他插件重复的键整批拒绝，不登记其中任何一项', () => {
    expect(() =>
      defineAdminActions('registry-test-b', {
        'registry-test.fresh': { stepUp: 'never', reason: '测试' },
        'credits.adjust': { stepUp: 'never', reason: '冒充模板动作' },
      }),
    ).toThrow('Duplicate admin action: credits.adjust')
    expect(getAdminActionDefinition('registry-test.fresh')).toBeUndefined()
    expect(getAdminActionDefinition('credits.adjust')?.stepUp).toBe('always')

    defineAdminActions('registry-test-c', {
      'registry-test.owned': { stepUp: 'never', reason: '' },
    })
    expect(() =>
      defineAdminActions('registry-test-d', {
        'registry-test.owned': { stepUp: 'never', reason: '' },
      }),
    ).toThrow('Duplicate admin action')
    // 同一插件模块重新加载（开发时热更新）覆盖自己的登记
    expect(() =>
      defineAdminActions('registry-test-c', {
        'registry-test.owned': { stepUp: 'always', reason: '' },
      }),
    ).not.toThrow()
  })

  it('不允许插件以模板身份登记', () => {
    expect(() => defineAdminActions('template', {})).toThrow('Reserved')
  })
})

describe('requiresStepUp', () => {
  const db = fakeDb([])

  it('未登记的动作名在运行时同样报错', async () => {
    await expect(requiresStepUp('nope' as 'credits.adjust', { db })).rejects.toThrow(
      'Unregistered admin action: nope',
    )
  })

  it('每个登记项都给出理由与判定规则', () => {
    for (const [name, definition] of Object.entries(adminActions)) {
      expect(definition.reason, name).not.toBe('')
      expect(['always', 'never', 'function']).toContain(
        typeof definition.stepUp === 'function' ? 'function' : definition.stepUp,
      )
    }
  })

  it('billing.refund_review 只在通过时敏感', async () => {
    const review = (decision: 'approve' | 'reject') =>
      requiresStepUp({ name: 'billing.refund_review', input: { decision } }, { db })
    expect(await review('approve')).toBe(true)
    expect(await review('reject')).toBe(false)
  })

  it('按输入判定的动作缺少输入时按敏感处理', async () => {
    expect(await requiresStepUp('billing.refund_review' as 'credits.adjust', { db })).toBe(true)
  })

  describe('setting.update', () => {
    const check = (rows: unknown[], entries: [string, unknown][]) =>
      requiresStepUp({ name: 'setting.update', input: { entries } }, { db: fakeDb(rows) })

    it('只改普通设置时不敏感', async () => {
      expect(await check([], [['site.announcement', 'Maintenance tonight']])).toBe(false)
    })

    it('改动密钥项时敏感', async () => {
      expect(await check([], [['operations.telegramBotToken', TOKEN]])).toBe(true)
      expect(await check([{ value: TOKEN }], [['operations.telegramBotToken', '']])).toBe(true)
    })

    it('密钥项与数据库现值相同（表单原样提交）不算改动', async () => {
      expect(
        await check(
          [{ value: TOKEN }],
          [
            ['site.announcement', 'x'],
            ['operations.telegramBotToken', TOKEN],
          ],
        ),
      ).toBe(false)
      // 未保存过时与默认值比较
      expect(await check([], [['operations.telegramBotToken', '']])).toBe(false)
    })

    it('未知键或不合法的值交给写入校验拒绝', async () => {
      expect(await check([], [['unknown.key', 'x']])).toBe(false)
      expect(await check([], [['operations.telegramBotToken', 'not-a-token']])).toBe(false)
    })
  })

  describe('ai.model_save', () => {
    const pricing = { mode: 'per_token', input: 1, output: 2 }
    const check = (rows: unknown[], input: Record<string, unknown>) =>
      requiresStepUp({ name: 'ai.model_save', input }, { db: fakeDb(rows) })

    it('新建模型敏感', async () => {
      expect(await check([], { pricing })).toBe(true)
      // 指定的模型不存在时按新建处理
      expect(await check([], { key: 'missing', pricing })).toBe(true)
    })

    it('定价不变时不敏感，键顺序不影响比较', async () => {
      const reordered = { output: 2, input: 1, mode: 'per_token' }
      expect(await check([{ pricing }], { id: 'model-id', pricing: reordered })).toBe(false)
      expect(await check([{ pricing }], { key: 'gpt', pricing: undefined })).toBe(false)
    })

    it('定价改变时敏感', async () => {
      expect(await check([{ pricing }], { key: 'gpt', pricing: { ...pricing, output: 3 } })).toBe(
        true,
      )
    })
  })

  it('始终 / 从不敏感的动作不看输入', async () => {
    expect(await requiresStepUp('credits.adjust', { db })).toBe(true)
    expect(await requiresStepUp('admin.confirmation.confirm', { db })).toBe(true)
    expect(await requiresStepUp('ai.model_toggle', { db })).toBe(false)
    expect(await requiresStepUp('user.impersonate.stop', { db })).toBe(false)
  })
})
