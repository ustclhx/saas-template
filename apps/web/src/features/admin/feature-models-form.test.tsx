// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { m } from '../../paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '../../paraglide/runtime.js'
import type { AdminFeatureModel } from './feature-models.ts'
import { FeatureModelsForm } from './feature-models-form.tsx'

Reflect.deleteProperty(Element.prototype, 'animate')

const api = vi.hoisted(() => ({ save: vi.fn(), invalidate: vi.fn() }))
vi.mock('./feature-models.functions.ts', () => ({ saveAdminFeatureModels: api.save }))
vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ invalidate: api.invalidate }) }))

const options = [{ key: 'general-text', provider: 'openai', providerModelId: 'gpt' }]
const items: AdminFeatureModel[] = [
  {
    feature: 'report.summary',
    kind: 'text',
    inherit: [],
    selected: 'general-text',
    selectedUnavailable: false,
    resolved: { modelKey: 'general-text', source: 'explicit' },
    options,
  },
  {
    feature: 'report.detail',
    kind: 'text',
    inherit: ['report.summary'],
    selected: 'long-text',
    selectedUnavailable: true,
    resolved: { modelKey: 'general-text', source: 'inherited', from: 'report.summary' },
    options,
  },
  {
    feature: 'cover.image',
    kind: 'image',
    inherit: [],
    selected: '',
    selectedUnavailable: false,
    resolved: { modelKey: null, source: 'unset' },
    options: [],
  },
]

beforeEach(() => {
  overwriteGetLocale(() => baseLocale)
  api.save.mockReset()
  api.invalidate.mockReset()
  api.invalidate.mockResolvedValue(undefined)
})
afterEach(cleanup)

describe('FeatureModelsForm', () => {
  it('登记表为空时不显示分组', () => {
    const { container } = render(<FeatureModelsForm items={[]} />)
    expect(container.innerHTML).toBe('')
  })

  it('显示每个功能的实际模型与来源：显式、所选已停用后沿用、未配置', () => {
    render(<FeatureModelsForm items={items} />)
    expect(screen.getByRole('heading', { name: m.admin_feature_models() })).toBeTruthy()
    expect(screen.getByText(m.admin_feature_models_explicit())).toBeTruthy()
    expect(
      screen.getByText(m.admin_feature_models_disabled_inherited({ from: 'report.summary' })),
    ).toBeTruthy()
    expect(
      screen.getByText(m.admin_feature_models_disabled_choice({ key: 'long-text' })),
    ).toBeTruthy()
    expect(screen.getByText(m.admin_feature_models_unset())).toBeTruthy()
    expect(screen.getByText(m.admin_feature_models_unset_hint())).toBeTruthy()
    expect(
      screen.getByRole('combobox', {
        name: m.admin_feature_models_select_label({ feature: 'report.detail' }),
      }),
    ).toBeTruthy()
  })

  it('保存提交当前选择（含保留的已停用模型）并刷新数据', async () => {
    api.save.mockResolvedValue({ ok: true })
    render(<FeatureModelsForm items={items} />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: m.admin_feature_models_save() }))
    })
    expect(api.save).toHaveBeenCalledWith({
      data: {
        values: {
          'report.summary': 'general-text',
          'report.detail': 'long-text',
          'cover.image': '',
        },
      },
    })
    expect(api.invalidate).toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe(
      m.admin_saved_changes_apply_within_about_60_seconds(),
    )
  })
})
