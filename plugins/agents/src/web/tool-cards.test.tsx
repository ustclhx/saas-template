// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ChatUIMessage } from '@web/features/ai/conversation.ts'
import { m } from '@web/paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '@web/paraglide/runtime.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@web/server/template-config.ts', () => ({
  templateConfig: { ai: { text: { reasoning: { display: false } } }, plugins: { agents: {} } },
}))

import { ChatMessageView } from '@web/features/ai/message-parts.tsx'
import { registerToolRenderer, resetToolRenderers } from '@web/features/ai/tool-renderers.ts'
import { agentToolPartRenderer, inputEntries } from './tool-cards.tsx'
import { exampleToolRenderers, fileCountSummary } from './tool-renderers.tsx'

// happy-dom 的 Web Animations 在取消时让 finished 拒绝（未处理）；去掉 animate，motion 改用脚本动画
Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })

type Part = ChatUIMessage['parts'][number]
const reply = (...parts: Part[]): ChatUIMessage => ({ id: 'a', role: 'assistant', parts })

const filesCall = (patch: Record<string, unknown>) =>
  ({
    type: 'tool-list_workspace_files',
    toolCallId: 'call_1',
    input: { limit: 200 },
    ...patch,
  }) as Part

function renderReply(message: ChatUIMessage, live = false, onRespond = vi.fn()) {
  render(
    <ChatMessageView
      message={message}
      live={live}
      status={undefined}
      renderToolPart={agentToolPartRenderer({ disabled: false, onRespond })}
    />,
  )
  return onRespond
}

beforeEach(() => {
  overwriteGetLocale(() => baseLocale)
  resetToolRenderers()
  for (const [name, renderer] of Object.entries(exampleToolRenderers))
    registerToolRenderer(name, renderer)
})
afterEach(cleanup)

describe('工具卡片', () => {
  it('已完成：显示名、工具名与状态，展开后为参数与结果摘要', () => {
    renderReply(
      reply(
        filesCall({
          state: 'output-available',
          output: { files: [{ name: 'a.png' }, { name: 'b.mp4' }] },
        }),
      ),
    )
    const card = document.querySelector('[data-agent-tool="list_workspace_files"]') as HTMLElement
    expect(card.textContent).toContain(m.agents_tool_list_files())
    expect(card.textContent).toContain('list_workspace_files')
    expect(card.querySelector('[data-tool-state="done"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(m.agents_tool_list_files()) }))
    expect(card.textContent).toContain('{"limit":200}')
    expect(card.textContent).toContain(fileCountSummary({ files: [1, 2] }) as string)
    // 不原样输出工具结果
    expect(card.textContent).not.toContain('a.png')
  })

  it('运行中显示执行中；回复已结束但仍无结果时按失败显示', () => {
    renderReply(reply(filesCall({ state: 'input-available' })), true)
    expect(document.querySelector('[data-tool-state="running"]')).toBeTruthy()
    cleanup()
    renderReply(reply(filesCall({ state: 'input-available' })), false)
    expect(document.querySelector('[data-tool-state="error"]')).toBeTruthy()
  })

  it('用户拒绝后显示「已拒绝」与说明', () => {
    renderReply(
      reply(filesCall({ state: 'output-denied', approval: { id: 'ap_1', approved: false } })),
    )
    const badge = document.querySelector('[data-tool-state="error"]') as HTMLElement
    expect(badge.textContent).toBe(m.agents_tool_denied())
  })

  it('未登记的工具显示通用名称与工具名', () => {
    renderReply(
      reply({
        type: 'tool-project_tool',
        toolCallId: 'c',
        state: 'output-available',
        input: {},
        output: { secret: 'x' },
      } as Part),
    )
    const card = document.querySelector('[data-agent-tool="project_tool"]') as HTMLElement
    expect(card.textContent).toContain(m.chat_ui_tool())
    expect(card.textContent).not.toContain('secret')
  })

  it('参数只展示对象的键值，长值截断', () => {
    expect(inputEntries({ a: 1, b: 'x'.repeat(200), c: undefined })).toEqual([
      ['a', '1'],
      ['b', `${'x'.repeat(120)}…`],
    ])
    expect(inputEntries('text')).toEqual([])
  })
})

describe('确认卡片', () => {
  const pending = filesCall({
    state: 'approval-requested',
    input: { prompt: '季度回顾封面', size: '1024x576' },
    approval: { id: 'ap_1' },
  })

  it('等待确认时显示工具名与参数，批准后以确认 id 回调，按钮随即不可用', () => {
    const onRespond = renderReply(reply(pending))
    const card = screen.getByRole('group', {
      name: m.agents_approval_title({ tool: m.agents_tool_list_files() }),
    })
    expect(card.textContent).toContain(m.agents_approval_badge())
    expect(card.textContent).toContain('季度回顾封面')
    expect(card.textContent).toContain('1024x576')
    fireEvent.click(screen.getByRole('button', { name: m.agents_approval_approve() }))
    expect(onRespond).toHaveBeenCalledWith('ap_1', true)
    expect(
      (screen.getByRole('button', { name: m.agents_approval_deny() }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('拒绝以 approved = false 回调', () => {
    const onRespond = renderReply(reply(pending))
    fireEvent.click(screen.getByRole('button', { name: m.agents_approval_deny() }))
    expect(onRespond).toHaveBeenCalledWith('ap_1', false)
  })

  it('只读空间不能批准或拒绝', () => {
    render(
      <ChatMessageView
        message={reply(pending)}
        live={false}
        status={undefined}
        renderToolPart={agentToolPartRenderer({ disabled: true, onRespond: vi.fn() })}
      />,
    )
    expect(
      (screen.getByRole('button', { name: m.agents_approval_approve() }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })
})
