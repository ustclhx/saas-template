// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '../../paraglide/runtime.js'
import { fakeChatServer, startReply } from './chat-test-stream.ts'
import type { PickerModel } from './model-picker.ts'
import type { SubjectChatData } from './subject-chat.server.ts'

const state = vi.hoisted(() => ({
  text: {
    thinking: { default: 'off', userToggle: false },
    reasoning: { display: false },
    followUps: { enabled: false },
  },
}))

vi.mock('../../server/template-config.ts', () => ({ templateConfig: { ai: { text: state.text } } }))
vi.mock('../analytics/track.ts', () => ({ trackEvent: vi.fn() }))
vi.mock('./conversations.functions.ts', () => ({ renameConversation: vi.fn() }))
vi.mock('../marketing/pricing-snapshot.ts', () => ({ pricingSnapshot: { plans: [] } }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/">{children}</a>,
  useNavigate: () => vi.fn(),
}))

const model: PickerModel = {
  id: 'm',
  key: 'general',
  pricing: { mode: 'per_call', credits: 2 },
  supportsThinking: false,
}

const data: SubjectChatData & { readOnly: boolean } = {
  subject: {
    type: 'report',
    label: 'Quarterly report',
    title: 'Ask about this report',
    suggestions: ['What changed?'],
    defaultModelKey: null,
  },
  conversation: { id: '01900000-0000-7000-8000-000000000001', title: 'Report chat' },
  conversations: [
    { id: '01900000-0000-7000-8000-000000000001', title: 'Report chat', updatedAt: new Date() },
  ],
  messages: [
    {
      id: 'u0',
      role: 'user',
      parts: [{ type: 'text', text: 'Earlier question' }],
      status: 'completed',
    },
  ],
  feedback: {},
  readOnly: false,
}

vi.mock('./subject-chat.functions.ts', () => ({
  getSubjectChat: vi.fn(async () => data),
  startSubjectConversation: vi.fn(),
  startTemporarySubjectConversation: vi.fn(),
  getFollowUps: vi.fn(async () => ({ questions: [] })),
  setMessageFeedback: vi.fn(),
}))
vi.mock('./model-picker.functions.ts', () => ({ getPickerModels: vi.fn(async () => [model]) }))

import { SubjectChat } from './subject-chat.tsx'

// happy-dom 的 Web Animations 在取消时让 finished 拒绝（未处理）；去掉 animate，motion 改用脚本动画
Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })

/** 等对象对话数据加载完成（外壳随之从加载态换成对话视图） */
const loaded = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

function desktop() {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  )
}

beforeEach(() => {
  overwriteGetLocale(() => baseLocale)
  desktop()
  window.scrollTo = vi.fn() as typeof window.scrollTo
  Element.prototype.scrollTo = vi.fn() as typeof Element.prototype.scrollTo
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('SubjectChat 嵌入式外壳', () => {
  it('panel 关闭再打开后消息与草稿仍在；关闭期间流继续并完成，不停止', async () => {
    const server = fakeChatServer()
    vi.stubGlobal('fetch', server.fetch)
    render(<SubjectChat slug="personal" subjectType="report" subjectId="r1" variant="panel" />)
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_subject_trigger() }))
    const panel = await screen.findByRole('dialog', { name: 'Ask about this report' })
    expect(panel.textContent).toContain('Quarterly report')
    expect(panel.textContent).toContain('Earlier question')

    const input = within(panel).getByRole('textbox', { name: m.chat_ui_message() })
    fireEvent.change(input, { target: { value: 'Why did costs rise?' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(server.streams).toHaveLength(1))
    const stream = server.streams[0]
    if (!stream) throw new Error('no stream')
    expect(stream.body).toMatchObject({ conversationId: data.conversation?.id })
    act(() => {
      startReply(stream, 'r1', data.conversation?.id)
      stream.send({ type: 'text-start', id: 't1' })
      stream.send({ type: 'text-delta', id: 't1', delta: 'Long requests' })
    })
    await waitFor(() => expect(panel.textContent).toContain('Long requests'))
    // 生成中写下一条草稿，然后关闭面板
    fireEvent.change(input, { target: { value: 'Next question draft' } })
    fireEvent.click(within(panel).getByRole('button', { name: m.chat_ui_close() }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    // 关闭期间流继续并完成
    await act(async () => {
      stream.send({ type: 'text-delta', id: 't1', delta: ' matter more.' })
      stream.send({ type: 'text-end', id: 't1' })
      stream.finish()
      await new Promise((resolve) => setTimeout(resolve, 80))
    })
    expect(stream.aborted).toBe(false)
    expect(server.stops).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_subject_trigger() }))
    const reopened = await screen.findByRole('dialog', { name: 'Ask about this report' })
    await waitFor(() => expect(reopened.textContent).toContain('Long requests matter more.'))
    expect(reopened.textContent).toContain('Why did costs rise?')
    expect(
      (within(reopened).getByRole('textbox', { name: m.chat_ui_message() }) as HTMLTextAreaElement)
        .value,
    ).toBe('Next question draft')
    // 生成已结束：输入区为发送按钮
    expect(within(reopened).getByRole('button', { name: m.chat_ui_send() })).toBeTruthy()
  })

  it('卸载（离开页面）时停止本地读取', async () => {
    const server = fakeChatServer()
    vi.stubGlobal('fetch', server.fetch)
    const { unmount } = render(
      <SubjectChat slug="personal" subjectType="report" subjectId="r1" variant="panel" />,
    )
    await loaded()
    fireEvent.click(screen.getByRole('button', { name: m.chat_ui_subject_trigger() }))
    const panel = await screen.findByRole('dialog')
    const input = within(panel).getByRole('textbox', { name: m.chat_ui_message() })
    fireEvent.change(input, { target: { value: 'Hello' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(server.streams).toHaveLength(1))
    const stream = server.streams[0]
    if (!stream) throw new Error('no stream')
    act(() => startReply(stream, 'r1', data.conversation?.id))
    unmount()
    await waitFor(() => expect(stream.aborted).toBe(true))
  })
})
