// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { m } from '@web/paraglide/messages.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioSubmitPage } from './studio-view.tsx'
import { StudioView } from './studio-view.tsx'

const fns = vi.hoisted(() => ({
  submitStudio: vi.fn(),
  getMediaTask: vi.fn(),
}))
vi.mock('../submit.functions.ts', () => ({ submitStudio: fns.submitStudio }))
vi.mock('../works.functions.ts', () => ({
  publishStudioWorkFn: vi.fn(),
  studioFileUrl: (workspaceId: string, fileId: string) =>
    `/api/files/${fileId}?workspaceId=${workspaceId}`,
}))
vi.mock('@saas/plugin-media/tasks-client', () => ({
  getMediaTask: fns.getMediaTask,
  previewMediaCancel: vi.fn(),
  cancelMediaTask: vi.fn(),
}))
vi.mock('@web/features/analytics/track.ts', () => ({ trackEvent: vi.fn() }))
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    hash,
    ...props
  }: {
    children: React.ReactNode
    to: string
    hash?: string
    params?: unknown
  }) => {
    const { params: _params, ...rest } = props as Record<string, unknown>
    return (
      <a href={hash ? `${to}#${hash}` : to} {...rest}>
        {children}
      </a>
    )
  },
}))

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

const WS = '01900000-0000-7000-8000-000000000001'
const REFERENCE = '01900000-0000-7000-8000-000000000009'
const TASK = '01900000-0000-7000-8000-000000000010'
const OUTPUT = '01900000-0000-7000-8000-000000000011'

const imageModel = {
  key: 'flux',
  displayName: 'FLUX 快速',
  kind: 'image' as const,
  pricing: { mode: 'per_call' as const, credits: 4 },
  paramsSchema: JSON.stringify({
    type: 'object',
    properties: {
      prompt: { type: 'string', title: 'Prompt', minLength: 1 },
      aspect_ratio: { type: 'string', title: '画面比例', enum: ['1:1', '16:9'], default: '1:1' },
    },
    required: ['prompt'],
  }),
}
const videoModel = {
  key: 'wan-i2v',
  displayName: 'Wan 2.2 图生视频',
  kind: 'video' as const,
  pricing: { mode: 'per_call' as const, credits: 40 },
  paramsSchema: JSON.stringify({
    type: 'object',
    properties: {
      prompt: { type: 'string', title: 'Prompt', minLength: 1 },
      image_url: { type: 'string', title: 'Image', format: 'file' },
    },
    required: ['prompt', 'image_url'],
  }),
}

function page(values: Partial<StudioSubmitPage> = {}): StudioSubmitPage {
  return {
    workspaceId: WS,
    workspaceSlug: 'ws',
    readOnly: false,
    models: [imageModel, videoModel],
    files: [{ id: REFERENCE, mime: 'image/png', size: 1_200_000, status: 'ready' }],
    kinds: ['image', 'video'],
    presets: [{ id: 'watercolor', name: '水彩', mode: 'image', text: 'watercolor style' }],
    balance: { available: 100, debt: 0 },
    ...values,
  } as StudioSubmitPage
}

const generate = () => screen.getByRole('button', { name: m.studio_generate() })

beforeEach(() => {
  fns.submitStudio.mockReset()
  fns.getMediaTask.mockReset()
})
afterEach(() => cleanup())

describe('创作页', () => {
  it('空态：显示启用的模式、模型显示名与预计消耗，未填提示词时不能生成', () => {
    render(<StudioView page={page()} recent={null} search={{}} />)
    expect(screen.getByRole('tab', { name: m.studio_mode_image() })).toBeTruthy()
    expect(screen.getByRole('tab', { name: m.studio_mode_video() })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: m.studio_model() }).textContent).toContain(
      'FLUX 快速',
    )
    expect(screen.getByText(m.studio_empty_title())).toBeTruthy()
    expect(screen.getByTestId('studio-estimate').textContent).toContain('4')
    expect(generate().hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: '水彩' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('只启用图片时不显示模式切换', () => {
    render(
      <StudioView
        page={page({ kinds: ['image'], models: [imageModel] })}
        recent={null}
        search={{}}
      />,
    )
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('做同款：按地址参数预填模型（切到视频模式）与提示词', () => {
    render(
      <StudioView page={page()} recent={null} search={{ model: 'wan-i2v', prompt: '湖面薄雾' }} />,
    )
    expect(
      screen.getByRole('tab', { name: m.studio_mode_video() }).getAttribute('aria-selected'),
    ).toBe('true')
    expect((screen.getByLabelText(m.studio_prompt()) as HTMLTextAreaElement).value).toBe('湖面薄雾')
    expect(screen.getByText(m.studio_reference_required_video())).toBeTruthy()
  })

  it('余额不足：提示本次需要与当前余额并提供充值入口，生成按钮不可用', () => {
    render(
      <StudioView
        page={page({ balance: { available: 2, debt: 0 } })}
        recent={null}
        search={{ prompt: '山间木屋' }}
      />,
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(m.studio_insufficient({ cost: 4, balance: 2 }))
    expect(within(alert).getByRole('link', { name: m.studio_recharge() }).getAttribute('href')).toBe(
      '/app/$slug/billing#credit-packs',
    )
    expect(generate().hasAttribute('disabled')).toBe(true)
  })

  it('提交后显示进行中，完成后显示结果与发布入口；提交带预设与参数', async () => {
    fns.submitStudio.mockResolvedValue({ ok: true, taskId: TASK, status: 'queued' })
    fns.getMediaTask.mockResolvedValue({
      id: TASK,
      status: 'succeeded',
      creditsCharged: 4,
      canCancel: false,
      files: [
        {
          id: OUTPUT,
          mime: 'image/png',
          size: 10,
          width: 1024,
          height: 1024,
          duration: null,
          downloadUrl: `/api/files/${OUTPUT}?workspaceId=${WS}`,
        },
      ],
    })
    render(<StudioView page={page()} recent={null} search={{}} />)
    fireEvent.change(screen.getByLabelText(m.studio_prompt()), { target: { value: '山间木屋' } })
    fireEvent.click(screen.getByRole('button', { name: '水彩' }))
    await act(async () => {
      fireEvent.click(generate())
    })
    expect(fns.submitStudio).toHaveBeenCalledWith({
      data: {
        slug: 'ws',
        mode: 'image',
        modelKey: 'flux',
        prompt: '山间木屋',
        presetId: 'watercolor',
        params: { aspect_ratio: '1:1' },
      },
    })
    expect(
      await screen.findByRole('img', { name: m.studio_result_label({ index: 1 }) }),
    ).toBeTruthy()
    expect(screen.getByTestId('studio-result-meta').textContent).toBe(
      `1024 × 1024 · ${m.studio_charged({ credits: 4 })}`,
    )
    expect(screen.getByRole('button', { name: m.studio_publish_to_gallery() })).toBeTruthy()
    expect(fns.getMediaTask.mock.calls[0]?.slice(0, 2)).toEqual([WS, TASK])
  })

  it('以图生视频缺少参考图时不提交并指出原因（选择参考图的提交见 e2e）', async () => {
    fns.submitStudio.mockResolvedValue({ ok: true, taskId: TASK, status: 'queued' })
    fns.getMediaTask.mockReturnValue(new Promise(() => {}))
    render(<StudioView page={page()} recent={null} search={{ mode: 'video', prompt: '镜头推进' }} />)
    await act(async () => {
      fireEvent.click(generate())
    })
    expect(fns.submitStudio).not.toHaveBeenCalled()
    expect(screen.getByText(m.studio_reference_missing())).toBeTruthy()
  })

  it('服务端返回余额不足时显示服务端给出的数值', async () => {
    fns.submitStudio.mockResolvedValue({
      ok: false,
      error: {
        code: 'INSUFFICIENT_CREDITS',
        message: 'Insufficient',
        details: { estimatedCredits: 8, availableCredits: 3 },
      },
    })
    render(<StudioView page={page()} recent={null} search={{ prompt: '山间木屋' }} />)
    await act(async () => {
      fireEvent.click(generate())
    })
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain(
        m.studio_insufficient({ cost: 8, balance: 3 }),
      ),
    )
  })
})
