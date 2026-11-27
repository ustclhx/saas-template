// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { Route } from '../../routes/admin/models.tsx'
import { fallbacksPayload, selectableFallbacks } from './admin-model-fallbacks.tsx'
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

type Data = Awaited<ReturnType<typeof getAdminModels>>

function renderPage(
  models: Data['models'] = [],
  fallbackOptions: Data['fallbackOptions'] = models.map(
    ({ key, displayName, kind, provider, enabled }) => ({
      key,
      displayName,
      kind,
      provider,
      enabled,
    }),
  ),
) {
  const Page = Route.options.component
  if (!Page) throw new Error('Admin models route has no component')

  const tokenPricing = { mode: 'token', inputPer1k: 1, outputPer1k: 1, minCharge: 1 }
  mocks.loaderData.mockReturnValue({
    models,
    hasMore: false,
    mediaProviders: ['fal'],
    defaults: { text: tokenPricing },
    fallbackOptions,
  })
  render(<Page />)
}

const textModel = {
  id: 'text-model',
  key: 'text-model',
  displayName: 'DeepSeek Flash',
  kind: 'text' as const,
  provider: 'deepseek',
  providerModelId: 'deepseek-flash',
  pricing: { mode: 'token', inputPer1k: 1, outputPer1k: 1, minCharge: 1 },
  paramsSchema: null,
  tags: [],
  enabled: true,
  sort: 0,
  supportsTools: true,
  fallbacks: [],
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
    const image = {
      ...textModel,
      id: 'image-model',
      key: 'image-model',
      displayName: null,
      kind: 'image' as const,
      provider: 'fal',
      providerModelId: 'fal-ai/flux/schnell',
      pricing: { mode: 'per_call', credits: 1 },
      supportsTools: false,
    }
    renderPage([textModel, image])
    const editor = within(screen.getByRole('article', { name: m.admin_model_title(textModel) }))
    const imageEditor = within(screen.getByRole('article', { name: m.admin_model_title(image) }))
    expect(imageEditor.queryByRole('switch', { name: m.admin_supports_tool_calls() })).toBeNull()

    const toggle = editor.getByRole('switch', { name: m.admin_supports_tool_calls() })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    fireEvent.click(editor.getByRole('button', { name: m.admin_save_changes() }))

    await waitFor(() => expect(editor.getByRole('status').textContent).toBe(m.admin_saved()))
    expect(mocks.saveAdminModel).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: textModel.id, supportsTools: false }),
    })
  })
})

describe('后台模型编辑器的显示名', () => {
  it('拒绝超过 60 个字符并允许保存 60 个字符', async () => {
    renderPage([textModel])
    const editor = within(screen.getByRole('article', { name: m.admin_model_title(textModel) }))
    const field = editor.getByRole<HTMLInputElement>('textbox', {
      name: m.admin_model_display_name(),
    })
    const save = editor.getByRole('button', { name: m.admin_save_changes() })

    fireEvent.change(field, { target: { value: '名'.repeat(61) } })
    fireEvent.click(save)
    expect(editor.getByRole('status').textContent).toBe(
      m.admin_model_display_name_too_long({ max: 60 }),
    )
    expect(mocks.saveAdminModel).not.toHaveBeenCalled()

    const displayName = '名'.repeat(60)
    fireEvent.change(field, { target: { value: displayName } })
    fireEvent.click(save)
    await waitFor(() => expect(editor.getByRole('status').textContent).toBe(m.admin_saved()))
    expect(mocks.saveAdminModel).toHaveBeenCalledWith({
      data: expect.objectContaining({ key: textModel.key, displayName }),
    })
  })

  it('回显已保存的显示名并可清空', async () => {
    renderPage([textModel])
    const editor = within(screen.getByRole('article', { name: m.admin_model_title(textModel) }))
    const field = editor.getByRole<HTMLInputElement>('textbox', {
      name: m.admin_model_display_name(),
    })
    expect(field.value).toBe(textModel.displayName)

    fireEvent.change(field, { target: { value: '' } })
    fireEvent.click(editor.getByRole('button', { name: m.admin_save_changes() }))
    await waitFor(() => expect(editor.getByRole('status').textContent).toBe(m.admin_saved()))
    expect(mocks.saveAdminModel).toHaveBeenCalledWith({
      data: expect.objectContaining({ id: textModel.id, displayName: null }),
    })
  })
})

describe('后台模型编辑器的备用模型', () => {
  const option = (key: string, kind: 'text' | 'image', provider: string, enabled = true) => ({
    key,
    displayName: null,
    kind,
    provider,
    enabled,
  })
  const options = [
    option('seedream-fal', 'image', 'fal'),
    option('seedream-fal-2', 'image', 'fal'),
    option('seedream-replicate', 'image', 'replicate', false),
    option('seedream-kie', 'image', 'kie'),
    option('gpt', 'text', 'openai'),
  ]
  const image = {
    ...textModel,
    id: 'image-model',
    key: 'seedream-fal',
    displayName: null,
    kind: 'image' as const,
    provider: 'fal',
    providerModelId: 'fal-ai/seedream',
    paramsSchema: {
      type: 'object',
      properties: { prompt: { type: 'string' }, image_size: { type: 'string' } },
      required: ['prompt'],
    },
    pricing: { mode: 'per_call', credits: 1 },
    supportsTools: false,
    fallbacks: [{ modelKey: 'seedream-replicate', paramMap: { image_size: 'size' } }],
  }

  it('下拉只列同类型、非自身、服务商与主模型及其他备用不同的模型（含已停用）', () => {
    const primary = { kind: 'image' as const, key: 'seedream-fal', provider: 'fal' }
    const keys = (value: { modelKey: string; params: [] }[], index: number) =>
      selectableFallbacks(options, primary, value, index).map(({ key }) => key)
    expect(keys([], 0)).toEqual(['seedream-replicate', 'seedream-kie'])
    const chosen = [
      { modelKey: 'seedream-replicate', params: [] as [] },
      { modelKey: '', params: [] as [] },
    ]
    expect(keys(chosen, 1)).toEqual(['seedream-kie'])
    // 已选中的模型即使不再符合条件也保留在选项中
    expect(keys([{ modelKey: 'seedream-fal-2', params: [] }], 0)).toEqual([
      'seedream-fal-2',
      'seedream-replicate',
      'seedream-kie',
    ])
  })

  it('保存载荷去掉空映射行，文本模型不带映射，有未选择的行时拒绝', () => {
    expect(
      fallbacksPayload('image', [
        {
          modelKey: 'b',
          params: [
            { from: ' image_size ', to: 'size' },
            { from: '', to: 'x' },
          ],
        },
        { modelKey: 'c', params: [] },
      ]),
    ).toEqual([{ modelKey: 'b', paramMap: { image_size: 'size' } }, { modelKey: 'c' }])
    expect(fallbacksPayload('text', [{ modelKey: 'b', params: [{ from: 'a', to: 'b' }] }])).toEqual(
      [{ modelKey: 'b' }],
    )
    expect(fallbacksPayload('image', [{ modelKey: '', params: [] }])).toBeUndefined()
  })

  it('回显已保存的备用与映射，编辑映射后随保存提交', async () => {
    renderPage([image], options)
    const editor = within(screen.getByRole('article', { name: m.admin_model_title(image) }))
    expect(
      editor.getByRole('combobox', { name: m.admin_fallback_n({ n: 1 }) }).textContent,
    ).toContain('seedream-replicate')
    const from = editor.getByRole<HTMLInputElement>('textbox', {
      name: m.admin_fallback_primary_param(),
    })
    expect(from.value).toBe('image_size')
    fireEvent.click(editor.getByRole('button', { name: m.admin_add_param_mapping() }))
    const [, newFrom] = editor.getAllByRole('textbox', { name: m.admin_fallback_primary_param() })
    const [, newTo] = editor.getAllByRole('textbox', { name: m.admin_fallback_target_param() })
    if (!newFrom || !newTo) throw new Error('mapping row missing')
    fireEvent.change(newFrom, { target: { value: 'num_images' } })
    fireEvent.change(newTo, { target: { value: 'n' } })
    fireEvent.click(editor.getByRole('button', { name: m.admin_save_changes() }))

    await waitFor(() => expect(editor.getByRole('status').textContent).toBe(m.admin_saved()))
    expect(mocks.saveAdminModel).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: image.id,
        fallbacks: [
          { modelKey: 'seedream-replicate', paramMap: { image_size: 'size', num_images: 'n' } },
        ],
      }),
    })
  })

  it('最多两个备用；空行阻止保存；服务端校验原因显示在表单上', async () => {
    renderPage([image], options)
    const editor = within(screen.getByRole('article', { name: m.admin_model_title(image) }))
    const add = editor.getByRole<HTMLButtonElement>('button', {
      name: m.admin_add_fallback_model(),
    })
    fireEvent.click(add)
    expect(add.disabled).toBe(true)
    fireEvent.click(editor.getByRole('button', { name: m.admin_save_changes() }))
    expect(editor.getByRole('status').textContent).toBe(m.admin_fallback_model_required())
    expect(mocks.saveAdminModel).not.toHaveBeenCalled()

    const [, removeSecond] = editor.getAllByRole('button', { name: m.admin_remove_fallback() })
    if (!removeSecond) throw new Error('second fallback missing')
    fireEvent.click(removeSecond)
    const reason = 'Fallback seedream-replicate is incompatible on parameter aspect_ratio'
    mocks.saveAdminModel.mockResolvedValueOnce({
      ok: false,
      error: 'MODEL_FALLBACK_INVALID',
      message: reason,
    })
    fireEvent.click(editor.getByRole('button', { name: m.admin_save_changes() }))
    await waitFor(() => expect(editor.getByRole('status').textContent).toBe(reason))
  })

  it('文本模型不显示参数映射', () => {
    renderPage([{ ...textModel, fallbacks: [{ modelKey: 'gpt' }] }], options)
    const editor = within(screen.getByRole('article', { name: m.admin_model_title(textModel) }))
    expect(editor.getByRole('combobox', { name: m.admin_fallback_n({ n: 1 }) })).toBeTruthy()
    expect(editor.queryByText(m.admin_fallback_param_map())).toBeNull()
  })
})
