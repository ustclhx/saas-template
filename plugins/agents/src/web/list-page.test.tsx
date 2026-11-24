// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { m } from '@web/paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '@web/paraglide/runtime.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const router = vi.hoisted(() => ({ navigate: vi.fn(), invalidate: vi.fn() }))

vi.mock('@web/server/template-config.ts', () => ({
  templateConfig: { ai: { text: { reasoning: { display: false } } }, plugins: { agents: {} } },
}))
vi.mock('./agents.functions.ts', () => ({
  createAgentConversation: vi.fn(async () => ({ ok: true, result: { id: 'new-id' } })),
  deleteAgentConversation: vi.fn(async () => ({ ok: true, result: { id: 'c1' } })),
}))
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => router.navigate,
  useRouter: () => router,
}))

import { createAgentConversation, deleteAgentConversation } from './agents.functions.ts'
import { AgentListPage, type AgentListPageData } from './list-page.tsx'

Object.defineProperty(Element.prototype, 'animate', { value: undefined, configurable: true })

const agents = [
  {
    id: 'assistant',
    name: '工作区助手',
    description: '查看空间文件',
    tools: ['current_time'],
    suggestions: [],
  },
  { id: 'writer', name: '写作助手', description: '起草文案', tools: [], suggestions: [] },
]
const models = [
  {
    id: '0193a000-0000-7000-8000-000000000001',
    key: 'general',
    pricing: { mode: 'per_call' as const, credits: 1 },
    supportsThinking: false,
  },
]

const page = (patch: Partial<AgentListPageData> = {}): AgentListPageData => ({
  conversations: [
    {
      id: 'c1',
      title: '空间文件统计',
      agentId: 'assistant',
      modelKey: 'general',
      updatedAt: new Date().toISOString(),
      turn: {
        id: 't1',
        status: 'running',
        steps: 1,
        creditsCharged: 0,
        modelKey: 'general',
        errorCode: null,
        awaitingApproval: true,
      },
    },
    {
      id: 'c2',
      title: '',
      agentId: 'assistant',
      modelKey: 'general',
      updatedAt: new Date().toISOString(),
      turn: null,
    },
  ],
  agents,
  models,
  readOnly: false,
  ...patch,
})

beforeEach(() => overwriteGetLocale(() => baseLocale))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('agent 对话列表', () => {
  it('每行显示标题（空标题为新对话）、最近一轮状态、agent 与模型', () => {
    render(<AgentListPage slug="personal" page={page()} />)
    const list = screen.getByRole('list', { name: m.agents_list_label() })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    const [first, second] = rows as [HTMLElement, HTMLElement]
    expect(within(first).getByRole('link', { name: '空间文件统计' })).toBeTruthy()
    expect(first.textContent).toContain(m.agents_state_awaiting())
    expect(first.textContent).toContain('工作区助手')
    expect(first.textContent).toContain('general')
    expect(within(second).getByRole('link', { name: m.agents_untitled() })).toBeTruthy()
    expect(second.textContent).toContain(m.agents_state_new())
  })

  it('没有对话时为空状态，可新建', () => {
    render(<AgentListPage slug="personal" page={page({ conversations: [] })} />)
    expect(screen.getByRole('heading', { name: m.agents_empty_title() })).toBeTruthy()
    expect(screen.queryByRole('list', { name: m.agents_list_label() })).toBeNull()
  })

  it('新建：选 agent 与模型后创建并进入对话页', async () => {
    render(<AgentListPage slug="personal" page={page()} />)
    fireEvent.click(screen.getAllByRole('button', { name: m.agents_new_chat() })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: m.agents_new_title() })
    const writer = within(dialog).getByRole('button', { name: /写作助手/ })
    expect(writer.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(writer)
    expect(writer.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(within(dialog).getByRole('button', { name: m.agents_new_start() }))
    await waitFor(() =>
      expect(createAgentConversation).toHaveBeenCalledWith({
        data: { slug: 'personal', agentId: 'writer', modelId: models[0]?.id },
      }),
    )
    expect(router.navigate).toHaveBeenCalledWith({
      to: '/app/$slug/agents/$conversationId',
      params: { slug: 'personal', conversationId: 'new-id' },
    })
  })

  it('没有可用模型时不能开始对话', async () => {
    render(<AgentListPage slug="personal" page={page({ models: [] })} />)
    fireEvent.click(screen.getAllByRole('button', { name: m.agents_new_chat() })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: m.agents_new_title() })
    expect(
      (within(dialog).getByRole('button', { name: m.agents_new_start() }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
  })

  it('创建失败时在弹窗内显示原因', async () => {
    vi.mocked(createAgentConversation).mockResolvedValueOnce({
      ok: false,
      error: 'MODEL_UNAVAILABLE',
    })
    render(<AgentListPage slug="personal" page={page()} />)
    fireEvent.click(screen.getAllByRole('button', { name: m.agents_new_chat() })[0] as HTMLElement)
    const dialog = await screen.findByRole('dialog', { name: m.agents_new_title() })
    fireEvent.click(within(dialog).getByRole('button', { name: m.agents_new_start() }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      m.chat_error_model_unavailable(),
    )
    expect(router.navigate).not.toHaveBeenCalled()
  })

  it('删除先经确认对话框，确认后刷新列表', async () => {
    render(<AgentListPage slug="personal" page={page()} />)
    fireEvent.pointerDown(
      screen.getByRole('button', { name: m.agents_row_actions({ title: '空间文件统计' }) }),
      { button: 0, ctrlKey: false },
    )
    fireEvent.click(await screen.findByRole('menuitem', { name: m.agents_delete() }))
    const confirm = await screen.findByRole('alertdialog')
    expect(confirm.textContent).toContain('空间文件统计')
    fireEvent.click(within(confirm).getByRole('button', { name: m.agents_delete() }))
    await waitFor(() =>
      expect(deleteAgentConversation).toHaveBeenCalledWith({
        data: { slug: 'personal', conversationId: 'c1' },
      }),
    )
    await waitFor(() => expect(router.invalidate).toHaveBeenCalled())
  })

  it('只读空间不能新建', () => {
    render(<AgentListPage slug="personal" page={page({ readOnly: true })} />)
    for (const button of screen.getAllByRole('button', { name: m.agents_new_chat() }))
      expect((button as HTMLButtonElement).disabled).toBe(true)
  })
})
