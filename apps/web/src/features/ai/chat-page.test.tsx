import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatUIMessage } from './conversation.ts'

const state = vi.hoisted(() => ({
  messages: [] as ChatUIMessage[],
  status: 'ready',
  text: { thinking: { default: 'off', userToggle: false }, reasoning: { display: false } },
}))

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: state.messages,
    status: state.status,
    sendMessage: vi.fn(),
    stop: vi.fn(),
    clearError: vi.fn(),
  }),
}))
vi.mock('../../server/template-config.ts', () => ({ templateConfig: { ai: { text: state.text } } }))
vi.mock('./conversations.functions.ts', () => ({ renameConversation: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({ Link: () => null }))

import { ChatPage } from './chat-page.tsx'

const render = () =>
  renderToStaticMarkup(
    <ChatPage
      slug="personal"
      conversation={{ id: 'c', title: 'Test' }}
      storedMessages={[]}
      models={[]}
      readOnly={false}
    />,
  )

beforeEach(() => {
  state.messages = []
  state.status = 'ready'
  state.text.thinking.userToggle = false
  state.text.thinking.default = 'off'
  state.text.reasoning.display = false
})

describe('chat reasoning controls', () => {
  it('仅模板允许时显示 thinking 开关，初始值遵循模板默认', () => {
    expect(render()).not.toContain('type="checkbox"')
    state.text.thinking.userToggle = true
    state.text.thinking.default = 'on'
    expect(render()).toMatch(/type="checkbox"[^>]*checked/)
  })

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
