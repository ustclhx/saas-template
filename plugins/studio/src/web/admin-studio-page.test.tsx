// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { m } from '@web/paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '@web/paraglide/runtime.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AdminStudioPage,
  type StudioReviewData,
  type StudioReviewRow,
} from './admin-studio-page.tsx'

// Radix Select 弹层与 motion 依赖的浏览器 API（同 packages/ui/test/data-table.test.tsx）
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.releasePointerCapture ??= () => {}
Reflect.deleteProperty(Element.prototype, 'animate')

const api = vi.hoisted(() => ({
  moderateAdminStudioWork: vi.fn(),
  moderateAdminStudioWorks: vi.fn(),
  getAdminStudioWorkPreview: vi.fn(),
  invalidate: vi.fn(),
  navigate: vi.fn(),
}))
vi.mock('./moderation.functions.ts', () => ({
  moderateAdminStudioWork: api.moderateAdminStudioWork,
  moderateAdminStudioWorks: api.moderateAdminStudioWorks,
  getAdminStudioWorkPreview: api.getAdminStudioWorkPreview,
}))
vi.mock('@tanstack/react-router', () => ({
  useRouter: () => ({ invalidate: api.invalidate }),
  useNavigate: () => api.navigate,
}))

const ID = (n: number) => `00000000-0000-7000-8000-00000000000${n}`

function row(overrides: Partial<StudioReviewRow> = {}): StudioReviewRow {
  return {
    id: ID(1),
    site: 'default',
    slug: 'misty-lake',
    title: 'Misty lake',
    prompt: 'Mist slowly lifts over the lake',
    kind: 'image',
    modelKey: 'fixture',
    authorId: ID(9),
    authorName: 'Author',
    workspaceId: ID(8),
    workspaceName: 'studio-demo',
    visibility: 'public',
    moderation: 'pending',
    removalReason: null,
    featuredAt: null,
    version: 2,
    reportCount: 0,
    publishedAt: new Date('2026-11-26T08:40:31Z'),
    reviewedAt: null,
    reportReasons: [],
    ...overrides,
  }
}

function data(rows: StudioReviewRow[], counts = { pending: 12, reported: 3, hidden: 1 }) {
  return { rows, hasMore: false, counts } satisfies StudioReviewData
}

beforeEach(() => {
  overwriteGetLocale(() => baseLocale)
  for (const fn of Object.values(api)) fn.mockReset()
  api.invalidate.mockResolvedValue(undefined)
  api.moderateAdminStudioWork.mockResolvedValue({})
})
afterEach(cleanup)

const table = () => screen.getByRole('table', { name: m.studio_admin_table_label() })

describe('AdminStudioPage', () => {
  it('待审核栏：分栏数量、缩略图走公开地址、UTC 时间与通过操作', async () => {
    render(<AdminStudioPage data={data([row()])} queue="pending" offset={0} />)
    // TabsItem 为测量宽度会渲染两份文字，按可读名称断言
    for (const name of [
      m.studio_admin_tab_count({ label: m.studio_admin_tab_pending(), count: 12 }),
      m.studio_admin_tab_count({ label: m.studio_admin_tab_reported(), count: 3 }),
      m.studio_admin_tab_count({ label: m.studio_admin_tab_hidden(), count: 1 }),
      m.studio_admin_tab_removed(),
    ])
      expect(screen.getByRole('tab', { name })).toBeTruthy()
    const thumb = within(table()).getByRole('button', {
      name: m.studio_admin_preview({ title: 'Misty lake' }),
    })
    expect(thumb.querySelector('img')?.getAttribute('src')).toBe(`/media/w/${ID(1)}/2`)
    expect(within(table()).getByText('2026-11-26 08:40 UTC')).toBeTruthy()

    fireEvent.click(within(table()).getByRole('button', { name: m.studio_admin_approve() }))
    await waitFor(() => expect(api.invalidate).toHaveBeenCalled())
    expect(api.moderateAdminStudioWork).toHaveBeenCalledWith({
      data: { workId: ID(1), action: 'approve' },
    })

    // Radix Tabs 在 mousedown 时切换
    fireEvent.mouseDown(
      screen.getByRole('tab', {
        name: m.studio_admin_tab_count({ label: m.studio_admin_tab_reported(), count: 3 }),
      }),
    )
    expect(api.navigate).toHaveBeenCalledWith({
      to: '/admin/studio',
      search: { queue: 'reported', offset: 0 },
    })
  })

  it('被举报栏：举报原因汇总、隐藏作品显示恢复与占位缩略图', async () => {
    const hidden = row({
      moderation: 'hidden',
      reportCount: 3,
      reportReasons: [
        { reason: 'copyright', total: 2, unresolved: 2 },
        { reason: 'spam', total: 1, unresolved: 1 },
      ],
    })
    render(<AdminStudioPage data={data([hidden])} queue="reported" offset={0} />)
    const summary = m.studio_admin_reports_summary({
      count: 3,
      reasons: [
        m.studio_admin_report_reason_item({
          reason: m.studio_admin_report_reason_copyright(),
          count: 2,
        }),
        m.studio_admin_report_reason_item({
          reason: m.studio_admin_report_reason_spam(),
          count: 1,
        }),
      ].join(m.studio_admin_report_reason_separator()),
    })
    expect(within(table()).getByText(summary)).toBeTruthy()
    expect(within(table()).queryByRole('button', { name: m.studio_admin_approve() })).toBeNull()
    // 隐藏作品不公开输出：缩略图为类型占位，预览经后台签名地址
    const thumb = within(table()).getByRole('button', {
      name: m.studio_admin_preview({ title: 'Misty lake' }),
    })
    expect(thumb.querySelector('img')).toBeNull()
    api.getAdminStudioWorkPreview.mockResolvedValue({
      url: 'https://r2.example.test/signed',
      mime: 'image/webp',
    })
    fireEvent.click(thumb)
    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(within(dialog).getByRole('img').getAttribute('src')).toBe(
        'https://r2.example.test/signed',
      ),
    )
    expect(api.getAdminStudioWorkPreview).toHaveBeenCalledWith({ data: { workId: ID(1) } })
    fireEvent.click(within(dialog).getByRole('button', { name: m.studio_admin_close() }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    fireEvent.click(within(table()).getByRole('button', { name: m.studio_admin_restore() }))
    await waitFor(() =>
      expect(api.moderateAdminStudioWork).toHaveBeenCalledWith({
        data: { workId: ID(1), action: 'restore' },
      }),
    )
  })

  it('下架必须先选原因；原因（作者可见）与说明（审计）分开提交', async () => {
    render(<AdminStudioPage data={data([row()])} queue="pending" offset={0} />)
    fireEvent.click(within(table()).getByRole('button', { name: m.studio_admin_remove() }))
    const dialog = await screen.findByRole('dialog', {
      name: m.studio_admin_remove_title({ title: 'Misty lake' }),
    })
    const confirm = within(dialog).getByRole('button', { name: m.studio_admin_remove_confirm() })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(within(dialog).getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: m.studio_admin_removal_copyright() }))
    fireEvent.change(within(dialog).getByLabelText(m.studio_admin_remove_note()), {
      target: { value: '  Rights holder letter  ' },
    })
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(api.moderateAdminStudioWork).toHaveBeenCalledWith({
        data: {
          workId: ID(1),
          action: 'remove',
          reason: m.studio_admin_removal_copyright(),
          note: 'Rights holder letter',
        },
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('批量通过：部分失败逐行标出并保持选中', async () => {
    const rows = [
      row({ id: ID(1), title: 'First' }),
      row({ id: ID(2), title: 'Second' }),
      row({ id: ID(3), title: 'Third' }),
    ]
    api.moderateAdminStudioWorks.mockResolvedValue([
      { workId: ID(1), ok: true, moderation: 'approved' },
      { workId: ID(2), ok: false, code: 'STUDIO_MODERATION_CONFLICT' },
    ])
    render(<AdminStudioPage data={data(rows)} queue="pending" offset={0} />)
    expect(screen.queryByRole('button', { name: m.studio_admin_bulk_approve() })).toBeNull()
    for (const title of ['First', 'Second'])
      fireEvent.click(
        within(table()).getByRole('checkbox', { name: m.studio_admin_select_row({ title }) }),
      )
    expect(screen.getByText(m.studio_admin_selected({ count: 2 }))).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: m.studio_admin_bulk_approve() }))
    })
    expect(api.moderateAdminStudioWorks).toHaveBeenCalledWith({
      data: { action: 'approve', workIds: [ID(1), ID(2)] },
    })
    await waitFor(() => expect(api.invalidate).toHaveBeenCalled())
    expect(within(table()).getByRole('alert').textContent).toBe(
      m.studio_admin_row_failed({ message: m.studio_admin_error_conflict() }),
    )
    expect(screen.getByText(m.studio_admin_selected({ count: 1 }))).toBeTruthy()
    expect(
      within(table())
        .getByRole('checkbox', { name: m.studio_admin_select_row({ title: 'Second' }) })
        .getAttribute('data-state'),
    ).toBe('checked')
  })

  it('批量下架经原因对话框提交', async () => {
    api.moderateAdminStudioWorks.mockResolvedValue([
      { workId: ID(1), ok: true, moderation: 'removed' },
    ])
    render(<AdminStudioPage data={data([row()])} queue="hidden" offset={0} />)
    // 已隐藏栏没有批量通过
    fireEvent.click(within(table()).getByRole('checkbox', { name: m.studio_admin_select_all() }))
    expect(screen.queryByRole('button', { name: m.studio_admin_bulk_approve() })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: m.studio_admin_bulk_remove() }))
    const dialog = await screen.findByRole('dialog', {
      name: m.studio_admin_remove_bulk_title({ count: 1 }),
    })
    fireEvent.click(within(dialog).getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: m.studio_admin_removal_spam() }))
    const confirm = await within(dialog).findByRole('button', {
      name: m.studio_admin_remove_confirm(),
    })
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(confirm)
    await waitFor(() =>
      expect(api.moderateAdminStudioWorks).toHaveBeenCalledWith({
        data: { action: 'remove', reason: m.studio_admin_removal_spam(), workIds: [ID(1)] },
      }),
    )
  })

  it('已下架栏：显示下架原因与恢复，没有复选框；空栏显示对应空态', () => {
    const removed = row({ moderation: 'removed', removalReason: 'Copyright' })
    const { unmount } = render(
      <AdminStudioPage data={data([removed])} queue="removed" offset={0} />,
    )
    expect(within(table()).queryAllByRole('checkbox')).toEqual([])
    expect(
      within(table()).getByText(m.studio_admin_removed_reason({ reason: 'Copyright' })),
    ).toBeTruthy()
    expect(within(table()).getByRole('button', { name: m.studio_admin_restore() })).toBeTruthy()
    expect(within(table()).queryByRole('button', { name: m.studio_admin_remove() })).toBeNull()
    unmount()

    render(<AdminStudioPage data={data([])} queue="pending" offset={0} />)
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.getByText(m.studio_admin_empty_pending_title())).toBeTruthy()
    expect(screen.getByText(m.studio_admin_empty_pending_body())).toBeTruthy()
  })
})
