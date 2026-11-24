// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { Route } from '../../routes/admin/models.tsx'
import type { getAdminModels } from './admin-models.functions.ts'

const mocks = vi.hoisted(() => ({
  loaderData: vi.fn(),
  invalidate: vi.fn(),
  saveAdminModel: vi.fn().mockResolvedValue({ ok: true, id: 'model' }),
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => (options: unknown) => ({
    options,
    useLoaderData: mocks.loaderData,
    useNavigate: vi.fn(),
    useSearch: () => ({ offset: 0 }),
  }),
  useRouter: () => ({ invalidate: mocks.invalidate }),
}))

vi.mock('./admin-models.functions.ts', () => ({
  copyAdminModel: vi.fn(),
  getAdminModels: vi.fn(),
  saveAdminModel: mocks.saveAdminModel,
  setAdminModelEnabled: vi.fn(),
}))

function renderPage(models: Awaited<ReturnType<typeof getAdminModels>>['models'] = []) {
  const Page = Route.options.component
  if (!Page) throw new Error('Admin models route has no component')

  const tokenPricing = { mode: 'token', inputPer1k: 1, outputPer1k: 1, minCharge: 1 }
  mocks.loaderData.mockReturnValue({
    models,
    hasMore: false,
    mediaProviders: ['fal'],
    defaults: { text: tokenPricing },
  })
  render(<Page />)
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(cleanup)

describe('后台模型编辑器的工具调用标记', () => {
  it('新建文本模型时默认关闭，开启后随新增请求保存', async () => {
    renderPage()
    fireEvent.click(screen.getByRole('button', { name: m.admin_new_model() }))
    const editor = within(screen.getByRole('article', { name: m.admin_new_model() }))
    const toggle = editor.getByRole('switch', { name: m.admin_supports_tool_calls() })
    expect(toggle.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(toggle)
    fireEvent.change(editor.getByLabelText(m.admin_key(), { exact: true }), {
      target: { value: 'tool-model' },
    })
    fireEvent.change(editor.getByLabelText(m.admin_provider(), { exact: true }), {
      target: { value: 'deepseek' },
    })
    fireEvent.change(editor.getByLabelText(m.admin_provider_model_id(), { exact: true }), {
      target: { value: 'deepseek-flash' },
    })
    fireEvent.click(editor.getByRole('button', { name: m.admin_create_model() }))

    await waitFor(() => expect(editor.getByRole('status').textContent).toBe(m.admin_saved()))
    expect(mocks.saveAdminModel).toHaveBeenCalledWith({
      data: expect.objectContaining({ key: 'tool-model', supportsTools: true }),
    })
  })

  it('编辑时显示已保存的文本模型标记并可关闭，媒体模型不显示开关', async () => {
    const text = {
      id: 'text-model',
      key: 'text-model',
      kind: 'text' as const,
      provider: 'deepseek',
      providerModelId: 'deepseek-flash',
      pricing: { mode: 'token', inputPer1k: 1, outputPer1k: 1, minCharge: 1 },
      paramsSchema: null,
      tags: [],
      enabled: true,
      sort: 0,
      supportsTools: true,
    }
    const image = {
      ...text,
      id: 'image-model',
      key: 'image-model',
      kind: 'image' as const,
      provider: 'fal',
      providerModelId: 'fal-ai/flux/schnell',
      pricing: { mode: 'per_call', credits: 1 },
      supportsTools: false,
    }
    renderPage([text, image])
    const editor = within(screen.getByRole('article', { name: m.admin_model_title(text) }))
    const imageEditor = within(screen.getByRole('article', { name: m.admin_model_title(image) }))
    expect(imageEditor.queryByRole('switch', { name: m.admin_supports_tool_calls() })).toBeNull()

    const toggle = editor.getByRole('switch', { name: m.admin_supports_tool_calls() })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    fireEvent.click(editor.getByRole('button', { name: m.admin_save_changes() }))

    await waitFor(() => expect(editor.getByRole('status').textContent).toBe(m.admin_saved()))
    expect(mocks.saveAdminModel).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: text.id, supportsTools: false }),
    })
  })
})
