import { chatErrorMessage } from '@web/features/ai/conversation.ts'
import { m } from '@web/paraglide/messages.js'
import { type AgentTurnPhase, type AgentTurnView, turnPhase } from './turns.ts'

// 列表与对话页共用的文案格式化（纯函数，便于组件测试）。

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 最近活动：一周内为相对时间（「1 分钟前」「昨天」），更早为日期 */
export function formatActivity(iso: string, now: number, locale: string): string {
  const time = new Date(iso).getTime()
  const diff = Math.max(0, now - time)
  if (diff < MINUTE) return m.agents_time_just_now()
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (diff < HOUR) return relative.format(-Math.floor(diff / MINUTE), 'minute')
  if (diff < DAY) return relative.format(-Math.floor(diff / HOUR), 'hour')
  if (diff < 7 * DAY) return relative.format(-Math.floor(diff / DAY), 'day')
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(time)
}

export type PhaseTone = 'muted' | 'warning' | 'destructive'

export const PHASE_TONE: Record<AgentTurnPhase, PhaseTone> = {
  none: 'muted',
  running: 'muted',
  awaiting: 'warning',
  completed: 'muted',
  stopped: 'muted',
  expired: 'muted',
  failed: 'destructive',
}

/** 列表中的最近一轮状态：「等待你确认」「已完成 · 4 步」「失败：模型暂不可用」 */
export function turnStateLabel(turn: AgentTurnView | null, compact = false): string {
  const phase = turnPhase(turn)
  switch (phase) {
    case 'none':
      return m.agents_state_new()
    case 'awaiting':
      return m.agents_state_awaiting()
    case 'running':
      return m.agents_state_running()
    case 'completed':
      return compact || !turn
        ? m.agents_state_completed()
        : m.agents_state_completed_steps({ steps: turn.steps })
    case 'stopped':
      return m.agents_state_stopped()
    case 'expired':
      return m.agents_state_expired()
    case 'failed':
      return compact || !turn?.errorCode
        ? m.agents_state_failed()
        : m.agents_state_failed_reason({ reason: chatErrorMessage(turn.errorCode) })
  }
}

/** 回答下方的本轮摘要：「本轮 3 步 · 消耗 6 积分 · 通用模型」，达到步数上限时追加说明 */
export function turnSummary(turn: AgentTurnView, maxSteps: number, credits: string): string {
  const base = m.agents_turn_summary({ steps: turn.steps, credits, model: turn.modelKey })
  return turn.steps >= maxSteps ? `${base} · ${m.agents_turn_max_steps()}` : base
}
