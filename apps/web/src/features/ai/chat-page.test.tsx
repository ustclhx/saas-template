import type { ChatTransport } from 'ai'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '../../paraglide/runtime.js'
import type { ChatUIMessage } from './conversation.ts'
import type { PickerModel } from './model-picker.ts'

const state = vi.hoisted(() => ({
  messages: [] as ChatUIMessage[],
  status: 'ready',
  error: undefined as Error | undefined,
  transport: undefined as ChatTransport<ChatUIMessage> | undefined,
  text: { thinking: { default: 'off', userToggle: false }, reasoning: { display: false } },
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: ({ transport }: { transport: ChatTransport<ChatUIMessage> }) => {
    state.transport = transport
    return {
      messages: state.messages,
      status: state.status,
      error: state.error,
      sendMessage: vi.fn(),
      stop: vi.fn(),
      clearError: vi.fn(),
    }
  },
}))
vi.mock('../../server/template-config.ts', () => ({ templateConfig: { ai: { text: state.text } } }))
vi.mock('./conversations.functions.ts', () => ({ renameConversation: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, hash }: { children: React.ReactNode; hash?: string }) => (
    <a href={hash ? `/app/personal/billing#${hash}` : '#'}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
}))

import { ChatPage } from './chat-page.tsx'

const model: PickerModel = {
  id: 'm',
  key: 'deepseek',
  pricing: { mode: 'per_call', credits: 1 },
  supportsThinking: true,
}

const render = (models: readonly PickerModel[] = [model]) =>
  renderToStaticMarkup(
    <ChatPage
      slug="personal"
      conversation={{ id: 'c', title: 'Test' }}
      storedMessages={[]}
      models={models}
      readOnly={false}
    />,
  )

beforeEach(() => {
  overwriteGetLocale(() => baseLocale)
  state.messages = []
  state.status = 'ready'
  state.error = undefined
  state.text.thinking.userToggle = false
  state.text.thinking.default = 'off'
  state.text.reasoning.display = false
})

afterEach(() => {
  vi.unstubAllGlobals()
  overwriteGetLocale(() => baseLocale)
})

describe('chat reasoning controls', () => {
  it('仅模板允许时显示 thinking 开关，初始值遵循模板默认', () => {
    expect(render()).not.toContain('type="checkbox"')
    state.text.thinking.userToggle = true
    state.text.thinking.default = 'on'
    expect(render()).toMatch(/type="checkbox"[^>]*checked/)
  })

  it('不可控或未选择模型时不显示 thinking 开关', () => {
    state.text.thinking.userToggle = true
    expect(render([{ ...model, supportsThinking: false }])).not.toContain('type="checkbox"')
    expect(render([])).not.toContain('type="checkbox"')
  })

  it.each([true, false])(
    '模型可控=%s 时发送正文只携带允许的 thinking 开关',
    async (supportsThinking) => {
      state.text.thinking.userToggle = true
      state.text.thinking.default = 'on'
      render([{ ...model, supportsThinking }])
      let body: Record<string, unknown> | undefined
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          body = JSON.parse(init?.body as string) as Record<string, unknown>
          return new Response('data: [DONE]\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          })
        }),
      )
      await state.transport?.sendMessages({
        trigger: 'submit-message',
        chatId: 'c',
        messageId: undefined,
        abortSignal: undefined,
        messages: [{ id: 'u', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      })
      expect(body).toMatchObject({
        modelId: model.id,
        message: { parts: [{ type: 'text', text: 'hi' }] },
      })
      if (supportsThinking) expect(body).toHaveProperty('thinking', true)
      else expect(body).not.toHaveProperty('thinking')
    },
  )

  it('reasoning 折叠显示且在关闭展示时隐藏', () => {
    state.messages = [
      {
        id: 'a',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'Private thought' },
          { type: 'text', text: 'Answer' },
        ],
      },
    ]
    expect(render()).not.toContain('Private thought')
    state.text.reasoning.display = true
    const markup = render()
    expect(markup).toContain('<summary>Reasoning</summary>')
    expect(markup).toContain('Private thought')
    expect(markup).not.toContain('<details open')
  })

  it('同一消息重试时移除旧 reasoning 并显示提示，新内容到达后取消提示', () => {
    state.status = 'streaming'
    state.text.reasoning.display = true
    const message: ChatUIMessage = {
      id: 'a',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'Discarded thought' },
        { type: 'data-retry', data: { n: 1 } },
      ],
    }
    state.messages = [message]
    const markup = render()
    expect(markup).not.toContain('Discarded thought')
    expect(markup).toContain('Retrying…')
    expect(markup.match(/aria-label="Assistant"/g)).toHaveLength(1)
    message.parts.push({ type: 'reasoning', text: 'Current thought' })
    expect(render()).not.toContain('Retrying…')
    expect(render()).toContain('Current thought')
  })
})

describe('insufficient credits guide', () => {
  it('SDK JSON 错误保留提示与数值，并提供打开余额不足弹窗的按钮', () => {
    state.error = new Error(
      JSON.stringify({
        error: {
          code: 'INSUFFICIENT_CREDITS',
          message: 'Insufficient credits',
          details: { estimatedCredits: 8, availableCredits: 2 },
        },
      }),
    )
    const markup = render()
    expect(markup).toContain(
      m.billing_credit_guide_amounts({ estimatedCredits: 8, availableCredits: 2 }),
    )
    // 弹窗（购买积分包 / 订阅两个入口）在客户端随错误打开，服务端只输出再次打开的按钮；
    // 打开与跳转由 e2e/ai-chat.spec.ts 覆盖
    expect(markup).toContain(m.chat_ui_credits_reopen())
    expect(markup).not.toContain('Go to billing')
    expect(markup).toContain('role="alert"')
  })

  it('欠费保留既有账单入口，不展示错误的余额数据', () => {
    state.error = new Error(
      JSON.stringify({
        error: { code: 'CREDIT_DEBT', details: { estimatedCredits: 8, availableCredits: 2 } },
      }),
    )
    const markup = render()
    expect(markup).toContain('Go to billing')
    expect(markup).not.toContain(m.chat_ui_credits_reopen())
    expect(markup).not.toContain(
      m.billing_credit_guide_amounts({ estimatedCredits: 8, availableCredits: 2 }),
    )
  })
})
