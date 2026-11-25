import { baseLocale, overwriteGetLocale } from '@web/paraglide/runtime.js'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AdminConfirmationView } from './confirmations.functions.ts'
import { confirmationRows } from './confirmations-display.tsx'

const view = (display: AdminConfirmationView['display']) =>
  ({ tool: 'credits.adjust', summary: 'summary', display }) as AdminConfirmationView

const workspace = { id: 'ws', name: 'Lin Studio', slug: 'lin' }

beforeEach(() => overwriteGetLocale(() => baseLocale))

describe('确认页表格：现值 → 执行后', () => {
  it('积分增加显示发起时余额与执行后余额', () => {
    const rows = confirmationRows(
      view({
        kind: 'credits',
        operation: 'grant',
        workspace,
        amount: 500,
        expiresAt: null,
        reason: 'Outage',
        balance: { before: 1200, after: 1700 },
      }),
    )
    expect(rows.find((row) => row.label === 'Credit balance')).toMatchObject({
      current: '1,200',
      after: '1,700',
    })
    expect(rows.some((row) => row.label === 'Credits')).toBe(false)
  })

  it('收回批次同时显示批次剩余与余额；没有余额快照的旧记录退回增加量', () => {
    const revoke = confirmationRows(
      view({
        kind: 'credits',
        operation: 'revoke',
        workspace,
        grant: { id: 'g1', amount: 100, remaining: 60 },
        reason: 'Mistake',
        balance: { before: 160, after: 100 },
      }),
    )
    expect(revoke.find((row) => row.label === 'Batch remaining')).toMatchObject({
      current: '60 / 100',
      after: '0 / 100',
    })
    expect(revoke.find((row) => row.label === 'Credit balance')).toMatchObject({
      current: '160',
      after: '100',
    })
    const legacy = confirmationRows(
      view({ kind: 'credits', operation: 'grant', workspace, amount: 7, reason: 'Old' }),
    )
    expect(legacy.find((row) => row.label === 'Credits')).toMatchObject({ after: '+7' })
  })

  it('退款、密钥设置与模型定价同样显示现值与新值', () => {
    const refund = confirmationRows(
      view({
        kind: 'refund',
        requestId: 'r1',
        workspace,
        payment: {
          id: 'p',
          provider: 'stripe',
          amount: 1234,
          refundedAmount: 200,
          currency: 'usd',
        },
        decision: 'approve',
        approvedAmount: 300,
        reviewNote: '',
      }),
    )
    expect(refund.find((row) => row.label === 'Refunded')).toMatchObject({
      current: '$2.00',
      after: '$5.00',
    })
    const setting = confirmationRows(
      view({
        kind: 'setting',
        key: 'notifications.telegramToken',
        before: { isSet: false },
        after: { isSet: true, last4: 'abcd' },
      }),
    )
    expect(setting.find((row) => row.label === 'Value')).toMatchObject({
      current: 'Not set',
      after: 'Set (ends with abcd)',
    })
    const model = confirmationRows(
      view({
        kind: 'model',
        key: 'general',
        changes: { pricing: { before: { input: 1 }, after: { input: 2 } } },
      }),
    )
    expect(model.find((row) => row.label === 'pricing')).toMatchObject({
      current: '{"input":1}',
      after: '{"input":2}',
    })
  })
})
