import { m } from '@web/paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '@web/paraglide/runtime.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { formatActivity, PHASE_TONE, turnStateLabel, turnSummary } from './format.ts'
import { type AgentTurnView, toTurnView, turnPhase } from './turns.ts'

const turn = (patch: Partial<AgentTurnView> = {}): AgentTurnView => ({
  id: 't1',
  status: 'completed',
  steps: 4,
  creditsCharged: 6,
  modelKey: 'general',
  errorCode: null,
  awaitingApproval: false,
  ...patch,
})

beforeEach(() => overwriteGetLocale(() => baseLocale))

describe('轮次摘要', () => {
  it('执行中且工具调用记录有等待确认项时为「等待确认」，终态忽略工具调用状态', () => {
    const row = {
      id: 't1',
      status: 'running' as const,
      steps: 1,
      creditsCharged: 0,
      modelKey: 'general',
      errorCode: null,
      toolCalls: [{ name: 'current_time', status: 'approval-requested' }],
    }
    expect(toTurnView(row).awaitingApproval).toBe(true)
    expect(turnPhase(toTurnView(row))).toBe('awaiting')
    expect(
      toTurnView({ ...row, toolCalls: [{ name: 'x', status: 'done' }] }).awaitingApproval,
    ).toBe(false)
    expect(toTurnView({ ...row, status: 'expired' }).awaitingApproval).toBe(false)
    expect(toTurnView({ ...row, toolCalls: null }).awaitingApproval).toBe(false)
  })

  it('不下发工具调用记录（只含审计与结算字段）', () => {
    const view = toTurnView({
      id: 't1',
      status: 'completed',
      steps: 2,
      creditsCharged: 3,
      modelKey: 'general',
      errorCode: null,
      toolCalls: [{ name: 'list_workspace_files', status: 'done' }],
    })
    expect(view).not.toHaveProperty('toolCalls')
  })

  it('列表状态：未开始、等待确认、完成步数、失败原因；颜色等级按状态区分', () => {
    expect(turnStateLabel(null)).toBe(m.agents_state_new())
    expect(turnStateLabel(turn({ status: 'running', awaitingApproval: true }))).toBe(
      m.agents_state_awaiting(),
    )
    expect(turnStateLabel(turn())).toBe(m.agents_state_completed_steps({ steps: 4 }))
    expect(turnStateLabel(turn(), true)).toBe(m.agents_state_completed())
    expect(turnStateLabel(turn({ status: 'failed', errorCode: 'MODEL_UNAVAILABLE' }))).toBe(
      m.agents_state_failed_reason({ reason: m.chat_error_model_unavailable() }),
    )
    expect(turnStateLabel(turn({ status: 'stopped' }))).toBe(m.agents_state_stopped())
    expect(PHASE_TONE.awaiting).toBe('warning')
    expect(PHASE_TONE.failed).toBe('destructive')
    expect(PHASE_TONE.completed).toBe('muted')
  })

  it('本轮摘要带步数、积分与模型，达到步数上限时追加提示', () => {
    expect(turnSummary(turn(), 8, '6')).toBe(
      m.agents_turn_summary({ steps: 4, credits: '6', model: 'general' }),
    )
    expect(turnSummary(turn({ steps: 8 }), 8, '6')).toContain(m.agents_turn_max_steps())
  })
})

describe('最近活动', () => {
  const now = Date.parse('2026-11-24T12:00:00Z')
  it('一分钟内为「刚刚」，一周内为相对时间，更早为日期', () => {
    expect(formatActivity('2026-11-24T11:59:30Z', now, 'zh')).toBe(m.agents_time_just_now())
    expect(formatActivity('2026-11-24T11:58:00Z', now, 'en')).toBe('2 minutes ago')
    expect(formatActivity('2026-11-23T11:00:00Z', now, 'en')).toBe('yesterday')
    expect(formatActivity('2026-11-01T11:00:00Z', now, 'en')).toBe('Nov 1')
  })
})
