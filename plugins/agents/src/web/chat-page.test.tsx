// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChatUIMessage } from '@web/features/ai/conversation.ts'
import type { PickerModel } from '@web/features/ai/model-picker.ts'
import { m } from '@web/paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '@web/paraglide/runtime.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** useAgentChat 的替身：测试改写 `chat` 后重新渲染 */
const state = vi.hoisted(() => ({
  chat: {} as Record<string, unknown>,
  agentOptions: [] as unknown[],
  chatOptions: [] as Record<string, unknown>[],
}))

vi.mock('@web/server/template-config.ts', () => ({
  templateConfig: {
    ai: {
      text: {
        reasoning: { display: false },
        thinking: { default: 'off', userToggle: false },
        followUps: { enabled: false },
      },
    },
    plugins: { agents: {} },
  },
}))
vi.mock('@web/features/analytics/track.ts', () => ({ trackEvent: vi.fn() }))
vi.mock('@web/features/marketing/pricing-snapshot.ts', () => ({ pricingSnapshot: { plans: [] } }))
vi.mock('agents/react', () => ({
  useAgent: (options: unknown) => {
    state.agentOptions.push(options)
    return { agent: 'agent-conversation', name: 'c1', getHttpUrl: () => 'http://x' }
  },
}))
vi.mock('@cloudflare/ai-chat/react', () => ({
  useAgentChat: (options: Record<string, unknown>) => {
    state.chatOptions.push(options)
    return state.chat
  },
}))
vi.mock('./agents.functions.ts', () => ({
  getAgentTurns: vi.fn(async () => null),
  renameAgentConversation: vi.fn(async () => ({ ok: true })),
  setAgentConversationModel: vi.fn(async () => ({ ok: true, result: { modelKey: 'other' } })),
  deleteAgentConversation: vi.fn(async () => ({ ok: true, result: { id: 'c1' } })),
  createAgentConversation: vi.fn(),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}))

import { renameAgentConversation } from './agents.functions.ts'
import { AgentChatPage, type AgentChatPageData, turnForMessage, turnReserve } from './chat-page.tsx'
import type { AgentTurnView } from './turns.ts'

Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })

const model: PickerModel = {
  id: 'm1',
  key: 'general',
  pricing: { mode: 'per_call', credits: 3 },
  supportsThinking: false,
}

const turn = (patch: Partial<AgentTurnView> = {}): AgentTurnView => ({
  id: 't1',
  status: 'completed',
  steps: 3,
  creditsCharged: 6,
  modelKey: 'general',
  errorCode: null,
  awaitingApproval: false,
  ...patch,
})

const page = (patch: Partial<AgentChatPageData> = {}): AgentChatPageData => ({
  conversation: { id: 'c1', title: '', modelKey: 'general' },
  agent: {
    id: 'assistant',
    name: '工作区助手',
    description: '查看空间文件',
    tools: ['current_time', 'list_workspace_files'],
    suggestions: ['列出文件'],
  },
  models: [model],
  turns: [],
  balance: 1280,
  maxSteps: 8,
  maxTurnCredits: null,
  readOnly: false,
  ...patch,
})

function chat(patch: Record<string, unknown> = {}) {
  state.chat = {
    messages: [] as ChatUIMessage[],
    status: 'ready',
    error: undefined,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    clearError: vi.fn(),
    addToolApprovalResponse: vi.fn(),
    isServerStreaming: false,
    isRecovering: false,
    connectionError: null,
    ...patch,
  }
  return state.chat
}

const user = (text: string, id = 'u1'): ChatUIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
})
const assistant = (parts: ChatUIMessage['parts'], id = 'a1'): ChatUIMessage => ({
  id,
  role: 'assistant',
  parts,
})

async function renderPage(data = page()) {
  const view = render(<AgentChatPage slug="personal" page={data} />)
  // 水合后才连接实例
  await waitFor(() => expect(state.chatOptions.length).toBeGreaterThan(0))
  return view
}

beforeEach(() => {
  overwriteGetLocale(() => baseLocale)
  state.agentOptions = []
  state.chatOptions = []
  chat()
})
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('连接', () => {
  it('按对话 id 连接 agent-conversation 实例，历史由实例端点读取', async () => {
    await renderPage()
    expect(state.agentOptions[0]).toEqual({ agent: 'agent-conversation', name: 'c1' })
    expect(state.chatOptions[0]?.getInitialMessages).toBeTypeOf('function')
  })
})

describe('空对话', () => {
  it('显示 agent 介绍、工具与示例任务，点击示例任务即发送', async () => {
    const { sendMessage } = chat() as { sendMessage: ReturnType<typeof vi.fn> }
    await renderPage()
    expect(screen.getByRole('heading', { name: '工作区助手' })).toBeTruthy()
    expect(screen.getByRole('list', { name: m.agents_tools_label() }).textContent).toContain(
      'list_workspace_files',
    )
    fireEvent.click(screen.getByRole('button', { name: '列出文件' }))
    expect(sendMessage).toHaveBeenCalledWith({ text: '列出文件' })
  })

  it('输入区显示最多步数与每轮预留、余额', async () => {
    await renderPage()
    expect(screen.getByText(m.agents_max_steps({ steps: 8 }))).toBeTruthy()
    const reserve = document.querySelector('[data-agent-reserve]') as HTMLElement
    expect(reserve.textContent).toBe(m.agents_reserve({ credits: '24', balance: '1,280' }))
  })
})

describe('对话', () => {
  it('生成中显示停止，停止后该回复标为已停止', async () => {
    const { stop } = chat({
      status: 'streaming',
      messages: [user('统计文件'), assistant([{ type: 'text', text: '正在统计' }])],
    }) as { stop: ReturnType<typeof vi.fn> }
    const view = await renderPage()
    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_stop() }))
    expect(stop).toHaveBeenCalled()
    chat({
      status: 'ready',
      messages: [user('统计文件'), assistant([{ type: 'text', text: '正在统计' }])],
    })
    view.rerender(<AgentChatPage slug="personal" page={page()} />)
    expect(screen.getByText(m.chat_ui_status_stopped())).toBeTruthy()
  })

  it('等待确认时显示确认卡片，批准经 addToolApprovalResponse 回传', async () => {
    const { addToolApprovalResponse } = chat({
      messages: [
        user('生成封面'),
        assistant([
          {
            type: 'tool-generate_image',
            toolCallId: 'call_9',
            state: 'approval-requested',
            input: { prompt: '季度回顾' },
            approval: { id: 'ap_9' },
          } as ChatUIMessage['parts'][number],
        ]),
      ],
    }) as { addToolApprovalResponse: ReturnType<typeof vi.fn> }
    await renderPage()
    expect(
      screen.getByRole('textbox', { name: m.chat_ui_message() }).getAttribute('placeholder'),
    ).toBe(m.agents_placeholder_awaiting())
    fireEvent.click(screen.getByRole('button', { name: m.agents_approval_approve() }))
    expect(addToolApprovalResponse).toHaveBeenCalledWith({ id: 'ap_9', approved: true })
  })

  it('回答下方显示本轮步数、积分与模型', async () => {
    chat({ messages: [user('统计文件'), assistant([{ type: 'text', text: '共 48 个文件' }])] })
    await renderPage(page({ turns: [turn()] }))
    expect(
      screen.getByText(m.agents_turn_summary({ steps: 3, credits: '6', model: 'general' })),
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: m.chat_ui_copy_reply() })).toBeTruthy()
  })

  it('本轮被拒时草稿保留；余额不足复用对话的提示与充值入口', async () => {
    const { sendMessage } = chat() as { sendMessage: ReturnType<typeof vi.fn> }
    const view = await renderPage()
    const textbox = screen.getByRole('textbox', {
      name: m.chat_ui_message(),
    }) as HTMLTextAreaElement
    fireEvent.change(textbox, { target: { value: '再试一次' } })
    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_send() }))
    expect(sendMessage).toHaveBeenCalledWith({ text: '再试一次' })
    expect(textbox.value).toBe('')
    const options = state.chatOptions.at(-1) as { onTurnEnd: (event: unknown) => void }
    act(() => options.onTurnEnd({ outcome: 'error', requestId: 'r', replay: false }))
    expect(textbox.value).toBe('再试一次')

    const error = new Error(
      JSON.stringify({
        error: {
          code: 'INSUFFICIENT_CREDITS',
          details: { estimatedCredits: 24, availableCredits: 5 },
        },
      }),
    )
    chat({ messages: [user('再试一次')], error })
    view.rerender(<AgentChatPage slug="personal" page={page()} />)
    // 余额不足弹窗自动打开（其余内容对读屏隐藏），提示中有再次打开的入口
    const alert = screen.getAllByRole('alert', { hidden: true })[0] as HTMLElement
    expect(alert.textContent).toContain(m.chat_error_insufficient_credits())
    expect(
      screen.getByRole('button', { name: m.chat_ui_credits_reopen(), hidden: true }),
    ).toBeTruthy()
  })

  it('首轮结束后用首条消息作为标题', async () => {
    chat({ messages: [user('统计本空间的文件'), assistant([{ type: 'text', text: '好的' }])] })
    await renderPage()
    await waitFor(() =>
      expect(renameAgentConversation).toHaveBeenCalledWith({
        data: { slug: 'personal', conversationId: 'c1', title: '统计本空间的文件' },
      }),
    )
    expect(screen.getByRole('heading', { level: 2, name: '统计本空间的文件' })).toBeTruthy()
  })

  it('只读空间不能发送', async () => {
    await renderPage(page({ readOnly: true }))
    expect(screen.getByText(m.chat_ui_read_only())).toBeTruthy()
    expect(screen.queryByRole('button', { name: m.agents_actions() })).toBeNull()
  })
})

describe('纯函数', () => {
  it('每轮预留 = 单步上限 × 最多步数，按 maxTurnCredits 封顶', () => {
    expect(turnReserve(model, { inputTokens: 10, maxSteps: 8, maxTurnCredits: null })).toBe(24)
    expect(turnReserve(model, { inputTokens: 10, maxSteps: 8, maxTurnCredits: 20 })).toBe(20)
    expect(turnReserve(undefined, { inputTokens: 10, maxSteps: 8, maxTurnCredits: null })).toBe(
      null,
    )
  })

  it('回复按元数据 turnId 匹配轮次，否则只有最后一条回复对应最近一轮', () => {
    const turns = [turn({ id: 't1' }), turn({ id: 't2' })]
    const tagged = { ...assistant([]), metadata: { turnId: 't1' } } as ChatUIMessage
    expect(turnForMessage(tagged, false, turns)?.id).toBe('t1')
    expect(turnForMessage(assistant([]), true, turns)?.id).toBe('t2')
    expect(turnForMessage(assistant([]), false, turns)).toBeUndefined()
  })
})
