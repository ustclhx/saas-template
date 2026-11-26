// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { m } from '@web/paraglide/messages.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StudioWorkItem, StudioWorksPage } from '../works.functions.ts'
import { StudioWorksView } from './works-view.tsx'

const fns = vi.hoisted(() => ({
  getStudioWorks: vi.fn(),
  publishStudioWorkFn: vi.fn(),
  unpublishStudioWorkFn: vi.fn(),
  deleteStudioWorkFn: vi.fn(),
}))
vi.mock('../works.functions.ts', () => fns)
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

// Radix 弹层依赖的浏览器 API，happy-dom 未实现
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

const WS = '01900000-0000-7000-8000-000000000001'

function item(
  index: number,
  work: StudioWorkItem['work'] = null,
  values: Partial<StudioWorkItem> = {},
): StudioWorkItem {
  const fileId = `01900000-0000-7000-8000-00000000010${index}`
  return {
    fileId,
    taskId: `01900000-0000-7000-8000-00000000020${index}`,
    kind: 'image',
    modelKey: 'flux',
    modelDisplayName: 'FLUX 快速',
    prompt: `提示词 ${index}`,
    mime: 'image/png',
    width: 1024,
    height: 1024,
    duration: null,
    createdAt: '2026-11-26T01:00:00.000Z',
    url: `/api/files/${fileId}?workspaceId=${WS}`,
    downloadUrl: `/api/files/${fileId}?workspaceId=${WS}`,
    work,
    ...values,
  }
}

function published(
  moderation: 'pending' | 'approved' | 'hidden' | 'removed',
  visibility: 'public' | 'private' = 'public',
  removalReason: string | null = null,
) {
  return {
    id: '01900000-0000-7000-8000-000000000300',
    title: `作品 ${moderation}`,
    slug: `work-${moderation}`,
    visibility,
    moderation,
    removalReason,
    showPrompt: true,
    version: 1,
  }
}

function page(values: Partial<StudioWorksPage> = {}): StudioWorksPage {
  return {
    workspaceId: WS,
    workspaceSlug: 'ws',
    kinds: ['image', 'video'],
    canWrite: true,
    readOnly: false,
    quota: { limit: 20, remaining: 17, resetsAt: '2026-11-27T00:00:00.000Z' },
    nextCursor: null,
    works: [
      item(1),
      item(2, published('pending')),
      item(3, published('approved')),
      item(4, published('hidden')),
      item(5, published('removed', 'public', '侵权')),
      item(6, null, { kind: 'video', mime: 'video/mp4', duration: 5 }),
    ],
    ...values,
  }
}

beforeEach(() => {
  for (const fn of Object.values(fns)) fn.mockReset()
})
afterEach(() => cleanup())

describe('我的作品', () => {
  it('显示各状态徽标（含下架原因）、视频时长与今日发布额度；下架作品没有发布或取消发布', () => {
    render(<StudioWorksView page={page()} filters={{}} onFiltersChange={() => {}} />)
    const states = screen.getAllByTestId('studio-work-state').map((badge) => badge.textContent)
    expect(states).toEqual([
      m.studio_state_private(),
      m.studio_state_pending(),
      m.studio_state_approved(),
      m.studio_state_hidden(),
      m.studio_state_removed_reason({ reason: '侵权' }),
      m.studio_state_private(),
    ])
    expect(screen.getByText('0:05')).toBeTruthy()
    expect(screen.getByTestId('studio-works-quota').textContent).toBe(
      m.studio_publish_quota({ remaining: 17, limit: 20 }),
    )
    const removed = screen.getByRole('article', { name: '作品 removed' })
    expect(within(removed).queryByRole('button', { name: m.studio_publish() })).toBeNull()
    expect(within(removed).queryByRole('button', { name: m.studio_unpublish() })).toBeNull()
    const first = screen.getByRole('article', { name: '提示词 1' })
    expect(within(first).getByRole('button', { name: m.studio_publish() })).toBeTruthy()
  })

  it('筛选按钮回调新的筛选条件，只有一种模式时不显示类型筛选', () => {
    const onFiltersChange = vi.fn()
    const view = render(
      <StudioWorksView
        page={page()}
        filters={{ kind: 'image' }}
        onFiltersChange={onFiltersChange}
      />,
    )
    const visibility = screen.getByRole('group', { name: m.studio_filter_visibility() })
    fireEvent.click(within(visibility).getByRole('button', { name: m.studio_filter_public() }))
    expect(onFiltersChange).toHaveBeenCalledWith({ kind: 'image', visibility: 'public' })
    const kind = screen.getByRole('group', { name: m.studio_filter_kind() })
    expect(
      within(kind)
        .getByRole('button', { name: m.studio_mode_image() })
        .getAttribute('aria-pressed'),
    ).toBe('true')
    view.unmount()
    render(
      <StudioWorksView page={page({ kinds: ['image'] })} filters={{}} onFiltersChange={() => {}} />,
    )
    expect(screen.queryByRole('group', { name: m.studio_filter_kind() })).toBeNull()
  })

  it('只读成员只能查看：显示说明，没有发布、取消发布与删除入口', () => {
    render(
      <StudioWorksView
        page={page({ canWrite: false, readOnly: true })}
        filters={{}}
        onFiltersChange={() => {}}
      />,
    )
    expect(screen.getByRole('note').textContent).toBe(m.studio_works_readonly())
    expect(screen.queryByRole('button', { name: m.studio_publish() })).toBeNull()
    expect(screen.queryByRole('button', { name: m.studio_unpublish() })).toBeNull()
    expect(screen.queryByRole('button', { name: /^More actions|^更多操作/ })).toBeNull()
    expect(screen.queryByTestId('studio-works-quota')).toBeNull()
  })

  it('空列表与筛选后为空显示不同说明，并提供创作入口', () => {
    const view = render(
      <StudioWorksView page={page({ works: [] })} filters={{}} onFiltersChange={() => {}} />,
    )
    expect(screen.getByRole('heading', { name: m.studio_works_empty_title() })).toBeTruthy()
    expect(screen.getByRole('link', { name: m.studio_start_create() })).toBeTruthy()
    view.unmount()
    render(
      <StudioWorksView
        page={page({ works: [] })}
        filters={{ visibility: 'public' }}
        onFiltersChange={() => {}}
      />,
    )
    expect(screen.getByRole('heading', { name: m.studio_works_empty_filtered() })).toBeTruthy()
  })

  it('取消发布后徽标变为未公开', async () => {
    fns.unpublishStudioWorkFn.mockResolvedValue({
      ok: true,
      work: { id: 'w', visibility: 'private', moderation: 'approved' },
    })
    render(<StudioWorksView page={page()} filters={{}} onFiltersChange={() => {}} />)
    const card = screen.getByRole('article', { name: '作品 approved' })
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: m.studio_unpublish() }))
    })
    expect(fns.unpublishStudioWorkFn).toHaveBeenCalledWith({
      data: { slug: 'ws', fileId: item(3).fileId },
    })
    expect(within(card).getByTestId('studio-work-state').textContent).toBe(m.studio_state_private())
  })

  it('发布对话框：默认标题取提示词，发布后更新徽标与额度；超出上限时显示上限与重置时间', async () => {
    fns.publishStudioWorkFn
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'STUDIO_PUBLISH_LIMIT',
          message: 'limit',
          details: { limit: 20, resetsAt: '2026-11-27T00:00:00.000Z' },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        work: {
          id: 'w1',
          slug: 'cabin-1',
          title: '山间木屋',
          visibility: 'public',
          moderation: 'pending',
        },
      })
    render(<StudioWorksView page={page()} filters={{}} onFiltersChange={() => {}} />)
    const card = screen.getByRole('article', { name: '提示词 1' })
    fireEvent.click(within(card).getByRole('button', { name: m.studio_publish() }))
    const dialog = await screen.findByRole('dialog', { name: m.studio_publish_title() })
    const title = within(dialog).getByLabelText(m.studio_publish_field_title()) as HTMLInputElement
    expect(title.value).toBe('提示词 1')
    expect(within(dialog).getByRole('switch').getAttribute('aria-checked')).toBe('true')
    fireEvent.change(title, { target: { value: '山间木屋' } })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: m.studio_publish_submit() }))
    })
    expect(within(dialog).getByRole('alert').textContent).toContain('20')
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: m.studio_publish_submit() }))
    })
    expect(fns.publishStudioWorkFn).toHaveBeenLastCalledWith({
      data: { slug: 'ws', fileId: item(1).fileId, title: '山间木屋', showPrompt: true },
    })
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: m.studio_publish_title() })).toBeNull(),
    )
    const updated = screen.getByRole('article', { name: '山间木屋' })
    expect(within(updated).getByTestId('studio-work-state').textContent).toBe(
      m.studio_state_pending(),
    )
    expect(screen.getByTestId('studio-works-quota').textContent).toBe(
      m.studio_publish_quota({ remaining: 16, limit: 20 }),
    )
  })
})
