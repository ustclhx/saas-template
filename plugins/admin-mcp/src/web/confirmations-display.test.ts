import { m } from '@web/paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '@web/paraglide/runtime.js'
import { beforeEach, describe, expect, it } from 'vitest'
import type { AdminConfirmationView } from './confirmations.functions.ts'
import { confirmationRows } from './confirmations-display.tsx'

const view = (display: AdminConfirmationView['display']) =>
  ({ tool: 'credits.adjust', summary: 'summary', display }) as AdminConfirmationView

const workspace = { id: 'ws', name: 'Lin Studio', slug: 'lin' }

beforeEach(() => overwriteGetLocale(() => baseLocale))

describe('确认页表格：现值 → 执行后', () => {
  it('待确认的积分增加按实时余额计算「当前 → 执行后」，并注明发起时余额', () => {
    const grant = view({
      kind: 'credits',
      operation: 'grant',
      workspace,
      amount: 500,
      expiresAt: null,
      reason: 'Outage',
      balance: { before: 1200, after: 1700 },
    })
    const live = confirmationRows(grant, { liveBalance: 1250 })
    expect(live.find((row) => row.label === m.admin_confirm_row_balance())).toMatchObject({
      current: '1,250',
      after: '1,750',
    })
    expect(
      live.find((row) => row.label === m.admin_confirm_row_balance_at_request()),
    ).toMatchObject({
      after: '1,200',
    })
    expect(live.some((row) => row.label === m.admin_confirm_row_amount())).toBe(false)
    // 已结束（无实时余额）：显示发起时的快照
    expect(
      confirmationRows(grant).find((row) => row.label === m.admin_confirm_row_balance_at_request()),
    ).toMatchObject({ current: '1,200', after: '1,700' })
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
    expect(
      confirmationRows(
        view({
          kind: 'credits',
          operation: 'revoke',
          workspace,
          grant: { id: 'g1', amount: 100, remaining: 60 },
          reason: 'Mistake',
          balance: { before: 160, after: 100 },
        }),
        { liveBalance: 150 },
      ).find((row) => row.label === m.admin_confirm_row_balance()),
    ).toMatchObject({ current: '150', after: '90' })
    expect(revoke.find((row) => row.label === m.admin_confirm_row_batch_remaining())).toMatchObject(
      {
        current: '60 / 100',
        after: '0 / 100',
      },
    )
    expect(
      revoke.find((row) => row.label === m.admin_confirm_row_balance_at_request()),
    ).toMatchObject({ current: '160', after: '100' })
    const legacy = confirmationRows(
      view({ kind: 'credits', operation: 'grant', workspace, amount: 7, reason: 'Old' }),
    )
    expect(legacy.find((row) => row.label === m.admin_confirm_row_amount())).toMatchObject({
      after: '+7',
    })
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
    expect(refund.find((row) => row.label === m.admin_confirm_row_refunded())).toMatchObject({
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
    expect(setting.find((row) => row.label === m.admin_confirm_row_value())).toMatchObject({
      current: m.admin_confirm_value_unset(),
      after: m.admin_confirm_value_set_suffix({ last4: 'abcd' }),
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
