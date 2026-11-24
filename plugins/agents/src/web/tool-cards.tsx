import { Button, cn } from '@saas/ui'
import { ToolCall, type ToolCallState } from '@saas/ui/chat'
import { ShieldCheck } from '@saas/ui/icons'
import {
  type RenderToolPart,
  type ToolPartView,
  toolCallState,
  toolLabels,
} from '@web/features/ai/message-parts.tsx'
import { type ToolCallView, toolRenderer } from '@web/features/ai/tool-renderers.ts'
import { m } from '@web/paraglide/messages.js'
import { getToolName } from 'ai'
import { type ReactNode, useId, useState } from 'react'

// agent 对话的工具卡片与确认卡片（设计稿 agents/Main.dc.html、Mobile.dc.html）：经 ChatMessageView 的
// renderToolPart 接入消息部件渲染器。显示名与结果摘要查 toolRenderers 注册表（插件、项目可按工具名登记），
// 卡片外壳复用 @saas/ui/chat 的 ToolCall（运行中 / 已完成 / 失败三态），等待确认时换成确认卡片。

/** 参数与结果的展示上限：只做概览，长值截断 */
const VALUE_LIMIT = 120

function displayValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > VALUE_LIMIT ? `${text.slice(0, VALUE_LIMIT)}…` : text
}

/** 工具参数的键值对；非对象或空对象时为空 */
export function inputEntries(input: unknown): [string, string][] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  return Object.entries(input as Record<string, unknown>)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, displayValue(value)])
}

/** 卡片上的状态：拒绝与「回复已结束但工具没有结果」都按失败三态之一显示 */
export function agentToolState(part: ToolPartView, live: boolean): ToolCallState {
  const raw = toolCallState(part.state)
  return !live && (raw === 'pending' || raw === 'running') ? 'error' : raw
}

function KeyValues({ rows, wide = false }: { rows: [string, ReactNode][]; wide?: boolean }) {
  // 键列宽：工具卡片 72px、确认卡片 96px（设计稿 .kv）
  return (
    <dl className={cn('flex flex-col gap-0.5', wide ? 'text-body' : 'text-caption')}>
      {rows.map(([key, value], index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 参数与结果行的键可能重复（如两行「结果」）
        <div key={index} className="flex gap-2">
          <dt className={cn('shrink-0 text-muted-foreground', wide ? 'w-24' : 'w-18')}>{key}</dt>
          <dd className="min-w-0 flex-1 wrap-anywhere text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function callView(part: ToolPartView, state: ToolCallState): ToolCallView {
  return {
    toolName: getToolName(part),
    toolCallId: part.toolCallId,
    state,
    input: part.input,
    output: part.state === 'output-available' ? part.output : undefined,
  }
}

/** 工具调用卡片：显示名 + 工具名（等宽）、状态徽标，展开为参数与结果摘要 */
export function AgentToolCard({ part, live }: { part: ToolPartView; live: boolean }) {
  const toolName = getToolName(part)
  const renderer = toolRenderer(toolName)
  const denied = part.state === 'output-denied'
  const state = agentToolState(part, live)
  const view = callView(part, state)
  const result = renderer?.render?.(view)
  const params = inputEntries(part.input)
  const rows: [string, ReactNode][] = []
  if (params.length)
    rows.push([
      m.agents_tool_params(),
      <span key="params" className="font-mono">
        {displayValue(part.input)}
      </span>,
    ])
  if (result != null && result !== false) rows.push([m.agents_tool_result(), result])
  if (denied) rows.push([m.agents_tool_result(), m.agents_tool_denied_detail()])
  else if (part.state === 'output-error')
    rows.push([m.agents_tool_result(), m.agents_tool_failed_detail()])
  return (
    <ToolCall
      data-agent-tool={toolName}
      name={
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate">{renderer ? renderer.label() : m.chat_ui_tool()}</span>
          <span className="truncate font-mono text-caption font-normal text-muted-foreground max-sm:hidden">
            {toolName}
          </span>
        </span>
      }
      state={state}
      labels={{ ...toolLabels(), ...(denied ? { error: m.agents_tool_denied() } : {}) }}
    >
      {rows.length ? <KeyValues rows={rows} /> : undefined}
    </ToolCall>
  )
}

export interface ApprovalCardProps {
  readonly part: ToolPartView
  readonly disabled?: boolean
  /** 批准或拒绝；返回后卡片切回工具卡片（续轮由服务端发起） */
  readonly onRespond: (approvalId: string, approved: boolean) => void
}

/** 确认卡片：执行前展示工具名与参数，批准后执行，拒绝时把拒绝结果交给模型继续本轮 */
export function ApprovalCard({ part, disabled = false, onRespond }: ApprovalCardProps) {
  const titleId = useId()
  const [responded, setResponded] = useState(false)
  const toolName = getToolName(part)
  const renderer = toolRenderer(toolName)
  const label = renderer ? renderer.label() : toolName
  const approvalId = part.state === 'approval-requested' ? part.approval.id : undefined
  const details = renderer?.render?.(callView(part, 'pending'))
  const params = inputEntries(part.input)
  const respond = (approved: boolean) => {
    if (!approvalId) return
    setResponded(true)
    onRespond(approvalId, approved)
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: 卡片不是表单，fieldset 的默认样式与语义都不合适（设计稿 role="group"）
    <div
      role="group"
      aria-labelledby={titleId}
      data-agent-approval={toolName}
      className="flex flex-col gap-3 rounded-lg border bg-card p-3.5 shadow-sm sm:px-4"
    >
      <div className="flex items-center gap-2">
        <ShieldCheck aria-hidden className="size-4 shrink-0" strokeWidth={1.5} />
        <span id={titleId} className="min-w-0 flex-1 font-semibold">
          {m.agents_approval_title({ tool: label })}
        </span>
        <span className="inline-flex h-4.5 shrink-0 items-center rounded-full bg-warning/10 px-1.5 font-medium text-caption text-warning dark:bg-warning/15">
          {m.agents_approval_badge()}
        </span>
      </div>
      {details != null && details !== false ? (
        <div className="text-body">{details}</div>
      ) : params.length ? (
        <KeyValues wide rows={params} />
      ) : null}
      <div className="flex flex-wrap items-center gap-2 max-sm:flex-col max-sm:items-stretch">
        <Button
          type="button"
          size="sm"
          className="max-sm:h-11"
          disabled={disabled || responded}
          onClick={() => respond(true)}
        >
          {m.agents_approval_approve()}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="max-sm:h-11"
          disabled={disabled || responded}
          onClick={() => respond(false)}
        >
          {m.agents_approval_deny()}
        </Button>
        <span className="ml-auto text-caption text-muted-foreground max-sm:hidden">
          {m.agents_approval_timeout()}
        </span>
      </div>
    </div>
  )
}

/** 交给 ChatMessageView 的渲染函数：等待确认时为确认卡片，其余为工具卡片 */
export function agentToolPartRenderer(options: {
  disabled: boolean
  onRespond: (approvalId: string, approved: boolean) => void
}): RenderToolPart {
  return (part, live) =>
    part.state === 'approval-requested' ? (
      <ApprovalCard part={part} disabled={options.disabled} onRespond={options.onRespond} />
    ) : (
      <AgentToolCard part={part} live={live} />
    )
}
