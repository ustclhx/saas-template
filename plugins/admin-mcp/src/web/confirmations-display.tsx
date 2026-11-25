import type { BadgeColor } from '@saas/ui'
import { adminMoney } from '@web/features/billing/admin-display.ts'
import { m } from '@web/paraglide/messages.js'
import type { ReactNode } from 'react'
import type { AdminConfirmationView } from './confirmations.functions.ts'

/**
 * 待确认记录的本地化展示（openspec add-admin-step-up 决策 8 实现备注：`summary` 为英文，
 * 确认页按 `display` 结构化内容本地化）。`display` 由各工具的 confirm 钩子在服务端生成，
 * 这里按 kind 逐项读取；不认识的结构退回英文摘要，不会因新工具而报错。
 */

type Json = AdminConfirmationView['display']
type Obj = { readonly [key: string]: Json }

const isObj = (value: Json | undefined): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: Json | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined
const num = (value: Json | undefined): number | undefined =>
  typeof value === 'number' ? value : undefined
const obj = (value: Json | undefined): Obj => (isObj(value) ? value : {})

/** 确认页表格的一行：`current` 缺省时该值横跨「当前值 / 执行后」两列 */
export interface ConfirmationRow {
  readonly label: string
  readonly current?: ReactNode
  readonly after: ReactNode
  readonly mono?: boolean
}

const formatCredits = (value: number) => new Intl.NumberFormat('en-US').format(value)

function workspaceLabel(display: Obj): string {
  const workspace = obj(display.workspace)
  const name = str(workspace.name) ?? str(workspace.id) ?? '—'
  const slug = str(workspace.slug)
  return slug ? `${name} (${slug})` : name
}

function workspaceName(display: Obj): string {
  const workspace = obj(display.workspace)
  return str(workspace.name) ?? str(workspace.slug) ?? str(workspace.id) ?? '—'
}

function refundAmount(display: Obj): string {
  const payment = obj(display.payment)
  const currency = (str(payment.currency) ?? 'usd').toUpperCase()
  return adminMoney(num(display.approvedAmount) ?? 0, currency)
}

/** 确认页标题与列表的「操作」列 */
export function confirmationTitle(record: AdminConfirmationView): string {
  const display = obj(record.display)
  switch (str(display.kind)) {
    case 'credits':
      return str(display.operation) === 'revoke'
        ? m.admin_confirm_title_revoke({ workspace: workspaceName(display) })
        : m.admin_confirm_title_grant({
            workspace: workspaceName(display),
            amount: formatCredits(num(display.amount) ?? 0),
          })
    case 'refund':
      return str(display.decision) === 'approve'
        ? m.admin_confirm_title_refund_approve({ amount: refundAmount(display) })
        : m.admin_confirm_title_refund_reject()
    case 'setting':
      return m.admin_confirm_title_setting({ key: str(display.key) ?? '—' })
    case 'model':
      return m.admin_confirm_title_model({ key: str(display.key) ?? '—' })
    default:
      return record.summary
  }
}

function settingValue(value: Json | undefined): string {
  const state = obj(value)
  if (state.isSet !== true) return m.admin_confirm_value_unset()
  const last4 = str(state.last4)
  return last4 ? m.admin_confirm_value_set_suffix({ last4 }) : m.admin_confirm_value_set()
}

/** 模型变更值（定价、参数等）按紧凑 JSON 显示，过长时截断 */
function compact(value: Json | undefined): string {
  if (value === undefined || value === null) return '—'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  const text = JSON.stringify(value)
  return text.length > 240 ? `${text.slice(0, 240)}…` : text
}

/**
 * 确认页「项目 / 当前值 / 执行后」表格。`liveBalance` 为打开确认页时读取的空间实时余额
 * （仅待确认的积分调整）：余额行按它加上本次调整量计算，另起一行注明发起时余额。
 */
export function confirmationRows(
  record: AdminConfirmationView,
  options: { readonly liveBalance?: number | null } = {},
): ConfirmationRow[] {
  const display = obj(record.display)
  const rows: ConfirmationRow[] = [
    { label: m.admin_confirm_row_tool(), after: record.tool, mono: true },
  ]
  switch (str(display.kind)) {
    case 'credits': {
      rows.push({ label: m.admin_confirm_row_workspace(), after: workspaceLabel(display) })
      // 积分余额「当前 → 执行后」（设计稿「积分余额 1,200 → 1,700」）。调整是增量、不以余额变化阻断：
      // 待确认时用实时余额加本次变化量，并注明发起时余额；已结束的记录显示发起时的快照。
      const balance = obj(display.balance)
      const before = num(balance.before)
      const after = num(balance.after)
      const live = options.liveBalance ?? undefined
      const balanceRows: ConfirmationRow[] =
        before === undefined || after === undefined
          ? []
          : live === undefined
            ? [
                {
                  label: m.admin_confirm_row_balance_at_request(),
                  current: formatCredits(before),
                  after: formatCredits(after),
                },
              ]
            : [
                {
                  label: m.admin_confirm_row_balance(),
                  current: formatCredits(live),
                  after: formatCredits(live + after - before),
                },
                {
                  label: m.admin_confirm_row_balance_at_request(),
                  after: formatCredits(before),
                },
              ]
      if (str(display.operation) === 'revoke') {
        const grant = obj(display.grant)
        rows.push(
          { label: m.admin_confirm_row_batch(), after: str(grant.id) ?? '—', mono: true },
          {
            label: m.admin_confirm_row_batch_remaining(),
            current: `${formatCredits(num(grant.remaining) ?? 0)} / ${formatCredits(num(grant.amount) ?? 0)}`,
            after: `0 / ${formatCredits(num(grant.amount) ?? 0)}`,
          },
        )
        rows.push(...balanceRows)
      } else {
        // 没有余额快照的记录（加入快照之前创建）只显示增加量
        if (balanceRows.length === 0)
          rows.push({
            label: m.admin_confirm_row_amount(),
            after: `+${formatCredits(num(display.amount) ?? 0)}`,
          })
        rows.push(...balanceRows, {
          label: m.admin_confirm_row_expires(),
          after: str(display.expiresAt) ?? m.admin_confirm_row_never(),
        })
      }
      rows.push({ label: m.admin_confirm_row_reason(), after: str(display.reason) ?? '—' })
      break
    }
    case 'refund': {
      const payment = obj(display.payment)
      const currency = (str(payment.currency) ?? 'usd').toUpperCase()
      const refunded = num(payment.refundedAmount) ?? 0
      const approve = str(display.decision) === 'approve'
      rows.push(
        { label: m.admin_confirm_row_workspace(), after: workspaceLabel(display) },
        { label: m.admin_confirm_row_request(), after: str(display.requestId) ?? '—', mono: true },
        {
          label: m.admin_confirm_row_payment(),
          after: adminMoney(num(payment.amount) ?? 0, currency),
        },
        {
          label: m.admin_confirm_row_refunded(),
          current: adminMoney(refunded, currency),
          after: adminMoney(
            refunded + (approve ? (num(display.approvedAmount) ?? 0) : 0),
            currency,
          ),
        },
        {
          label: m.admin_confirm_row_decision(),
          after: approve ? m.admin_confirm_decision_approve() : m.admin_confirm_decision_reject(),
        },
      )
      const note = str(display.reviewNote)
      if (note) rows.push({ label: m.admin_confirm_row_note(), after: note })
      break
    }
    case 'setting':
      rows.push(
        { label: m.admin_confirm_row_setting(), after: str(display.key) ?? '—', mono: true },
        {
          label: m.admin_confirm_row_value(),
          current: settingValue(display.before),
          after: settingValue(display.after),
        },
      )
      break
    case 'model': {
      rows.push({ label: m.admin_confirm_row_model(), after: str(display.key) ?? '—', mono: true })
      for (const [field, change] of Object.entries(obj(display.changes))) {
        const values = obj(change)
        rows.push({
          label: field,
          current: compact(values.before),
          after: compact(values.after),
          mono: true,
        })
      }
      break
    }
    default:
      break
  }
  return rows
}

export type ConfirmationState = 'open' | 'done' | 'not_run' | 'failed' | 'rejected' | 'expired'

const NOT_RUN_CODES = new Set(['TOKEN_REVOKED', 'STALE_TARGET', 'SECRET_UNAVAILABLE'])

function failureCode(record: AdminConfirmationView): string | undefined {
  return str(obj(record.result).code)
}

/** 状态与徽标；`now` 用于判断仍为 pending 但已到期（页面打开后跨过有效期）的记录 */
export function confirmationStatus(
  record: AdminConfirmationView,
  now: number,
): { readonly state: ConfirmationState; readonly label: string; readonly color: BadgeColor } {
  switch (record.status) {
    case 'pending':
      return new Date(record.expiresAt).getTime() <= now
        ? { state: 'expired', label: m.admin_confirm_status_expired(), color: 'gray' }
        : { state: 'open', label: m.admin_confirm_status_pending(), color: 'amber' }
    case 'running':
      return { state: 'open', label: m.admin_confirm_status_running(), color: 'gray' }
    case 'done':
      return { state: 'done', label: m.admin_confirm_status_done(), color: 'green' }
    case 'failed':
      return NOT_RUN_CODES.has(failureCode(record) ?? '')
        ? { state: 'not_run', label: m.admin_confirm_status_not_run(), color: 'red' }
        : { state: 'failed', label: m.admin_confirm_status_failed(), color: 'red' }
    case 'rejected':
      return { state: 'rejected', label: m.admin_confirm_status_rejected(), color: 'gray' }
    default:
      return { state: 'expired', label: m.admin_confirm_status_expired(), color: 'gray' }
  }
}

/** 终态的结果说明；待确认时为 null */
export function confirmationBanner(
  record: AdminConfirmationView,
  now: number,
): { readonly text: string; readonly tone: 'success' | 'destructive' | 'default' } | null {
  const { state } = confirmationStatus(record, now)
  const result = obj(record.result)
  switch (state) {
    case 'done': {
      const followUp = obj(result.followUpError)
      const code = str(followUp.code) ?? str(result.followUpError)
      if (code) return { text: m.admin_confirm_banner_follow_up({ code }), tone: 'destructive' }
      return {
        text:
          str(obj(record.display).kind) === 'refund'
            ? m.admin_confirm_banner_done_refund()
            : m.admin_confirm_banner_done(),
        tone: 'success',
      }
    }
    case 'not_run': {
      const code = failureCode(record)
      const text =
        code === 'TOKEN_REVOKED'
          ? m.admin_confirm_banner_revoked()
          : code === 'STALE_TARGET'
            ? m.admin_confirm_banner_stale()
            : m.admin_confirm_banner_secret()
      return { text, tone: 'destructive' }
    }
    case 'failed':
      return {
        text: m.admin_confirm_banner_failed({
          message: str(result.message) ?? failureCode(record) ?? '—',
        }),
        tone: 'destructive',
      }
    case 'rejected':
      return { text: m.admin_confirm_banner_rejected(), tone: 'default' }
    case 'expired':
      return { text: m.admin_confirm_banner_expired(), tone: 'default' }
    default:
      return null
  }
}

/** 剩余有效期（整分钟向上取整） */
export function minutesUntil(expiresAt: Date | string, now: number): number {
  const ms = new Date(expiresAt).getTime() - now
  return ms <= 0 ? 0 : Math.max(1, Math.ceil(ms / 60_000))
}
