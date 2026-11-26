// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { m } from '@web/paraglide/messages.js'
import { baseLocale, overwriteGetLocale } from '@web/paraglide/runtime.js'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GalleryPageData, WorkPageData } from './gallery.functions.ts'
import { GalleryErrorPage, GalleryPage } from './gallery-page.tsx'
import { reportOutcome } from './report-dialog.tsx'
import { WorkNotFound, WorkPage } from './work-page.tsx'

// happy-dom 的 Web Animations 在卸载时抛出 AbortError；去掉后 motion 退回到 JS 驱动的动画
Reflect.deleteProperty(Element.prototype, 'animate')

const api = vi.hoisted(() => ({ context: vi.fn(), fetch: vi.fn() }))
vi.mock('./report.functions.ts', () => ({ getStudioReportContext: api.context }))
// 路由链接渲染为普通 <a href>（真实 Link 需要路由上下文）
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: {
    to: string
    params?: Record<string, string>
    children?: ReactNode
  }) => (
    <a href={params ? to.replace('$slug', params.slug ?? '') : to} {...props}>
      {children}
    </a>
  ),
}))

// 营销站外壳依赖路由与语言上下文，这里换成带页头的简单外壳
vi.mock('@web/features/marketing/marketing-shell.tsx', () => ({
  MarketingShell: ({ children }: { children: ReactNode }) => (
    <div>
      <header>site</header>
      <main>{children}</main>
    </div>
  ),
}))

const ID = '0190a3f0-0000-7000-8000-000000000001'
const card = (overrides: Partial<GalleryPageData['works'][number]> = {}) => ({
  id: ID,
  slug: 'misty-lake-abc12345',
  title: 'Misty lake',
  kind: 'image' as const,
  displayName: 'FLUX',
  width: 1024,
  height: 768,
  durationMs: null,
  version: 3,
  publishedAt: '2026-11-26T00:00:00.000Z',
  featuredAt: null,
  ...overrides,
})

function gallery(overrides: Partial<GalleryPageData> = {}): GalleryPageData {
  return {
    kinds: ['image', 'video'],
    page: 1,
    works: [
      card(),
      card({
        id: `${ID.slice(0, -1)}2`,
        slug: 'v-1',
        kind: 'video',
        durationMs: 5_000,
        title: 'Clip',
      }),
    ],
    nextPage: 2,
    nextCursor: 'latest~x~y',
    ...overrides,
  }
}

function work(overrides: Partial<WorkPageData['work']> = {}): WorkPageData {
  return {
    work: {
      ...card(),
      modelKey: 'flux-fast',
      prompt: 'misty lake at dawn',
      moderation: 'approved',
      isAuthor: false,
      ...overrides,
    },
    related: [card({ id: `${ID.slice(0, -1)}9`, slug: 'other-1', title: 'Other' })],
  }
}

beforeEach(() => {
  overwriteGetLocale(() => baseLocale)
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  vi.stubGlobal('fetch', api.fetch)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('画廊页', () => {
  it('正常态：筛选为链接，卡片指向作品页，媒体用版本化公开地址，视频带时长角标，分页可抓取', () => {
    render(<GalleryPage data={gallery()} search={{}} />)
    expect(screen.getByRole('heading', { level: 1, name: m.studio_gallery_title() })).toBeTruthy()
    const kinds = screen.getByRole('navigation', { name: m.studio_gallery_filter_kind() })
    expect(
      within(kinds).getByText(m.studio_gallery_filter_all()).getAttribute('aria-current'),
    ).toBe('page')
    expect(within(kinds).getByText(m.studio_gallery_filter_video()).getAttribute('href')).toBe(
      '/gallery?kind=video',
    )
    const link = screen.getByRole('link', { name: 'Misty lake' })
    expect(link.getAttribute('href')).toBe('/gallery/misty-lake-abc12345')
    expect(link.querySelector('img')?.getAttribute('src')).toBe(`/media/w/${ID}/3`)
    expect(link.querySelector('img')?.getAttribute('loading')).toBe('eager')
    expect(screen.getByText('0:05')).toBeTruthy()
    const pagination = screen.getByRole('navigation', { name: m.studio_gallery_pagination() })
    expect(
      within(pagination).getByText(m.studio_gallery_next()).closest('a')?.getAttribute('href'),
    ).toBe('/gallery?page=2')
  })

  it('最新列表中的精选作品显示精选角标', () => {
    render(
      <GalleryPage
        data={gallery({ works: [card({ featuredAt: '2026-11-26T00:00:00.000Z' })] })}
        search={{}}
      />,
    )
    const link = screen.getByRole('link', { name: 'Misty lake' })
    expect(within(link).getByText(m.studio_gallery_featured_badge())).toBeTruthy()
  })

  it('筛选后分页保留筛选；只启用一种类型时不显示类型筛选', () => {
    render(
      <GalleryPage
        data={gallery({ kinds: ['image'] })}
        search={{ kind: 'image', sort: 'featured' }}
      />,
    )
    expect(screen.queryByRole('navigation', { name: m.studio_gallery_filter_kind() })).toBeNull()
    const pagination = screen.getByRole('navigation', { name: m.studio_gallery_pagination() })
    expect(
      within(pagination).getByText(m.studio_gallery_next()).closest('a')?.getAttribute('href'),
    ).toBe('/gallery?kind=image&sort=featured&page=2')
  })

  it('第 50 页之后只有「更早」游标链接', () => {
    render(<GalleryPage data={gallery({ page: 50, nextPage: null })} search={{ page: 50 }} />)
    expect(screen.getByText(m.studio_gallery_older()).getAttribute('href')).toBe(
      '/gallery?cursor=latest%7Ex%7Ey',
    )
  })

  it('空态与筛选空态', () => {
    render(
      <GalleryPage data={gallery({ works: [], nextPage: null, nextCursor: null })} search={{}} />,
    )
    expect(screen.getByText(m.studio_gallery_empty_title())).toBeTruthy()
    expect(screen.getByText(m.studio_gallery_start_creating()).getAttribute('href')).toBe('/app')
    cleanup()
    render(
      <GalleryPage
        data={gallery({ works: [], nextPage: null, nextCursor: null })}
        search={{ kind: 'video' }}
      />,
    )
    expect(screen.getByText(m.studio_gallery_empty_filtered_title())).toBeTruthy()
  })

  it('错误态：带站点导航与返回首页', () => {
    render(<GalleryErrorPage />)
    expect(screen.getByRole('alert').textContent).toContain(m.studio_gallery_error_title())
    expect(screen.getByText(m.studio_gallery_back_home()).getAttribute('href')).toBe('/')
    expect(screen.getAllByRole('banner').length).toBeGreaterThan(0)
  })
})

describe('作品页', () => {
  it('图片作品：标题、模型、尺寸、提示词、做同款与相关作品', () => {
    render(<WorkPage data={work()} />)
    expect(screen.getByRole('heading', { level: 1, name: 'Misty lake' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Misty lake' }).getAttribute('src')).toBe(
      `/media/w/${ID}/3`,
    )
    expect(screen.getAllByText('1024 × 768').length).toBeGreaterThan(0)
    expect(screen.getByText('misty lake at dawn')).toBeTruthy()
    for (const remix of screen.getAllByText(m.studio_work_remix()))
      expect(remix.closest('a')?.getAttribute('href')).toBe('/gallery/remix/misty-lake-abc12345')
    expect(screen.getByRole('link', { name: 'Other' }).getAttribute('href')).toBe(
      '/gallery/other-1',
    )
    expect(screen.queryByText(m.studio_work_pending_notice())).toBeNull()
  })

  it('提示词未公开时显示说明且无复制按钮', () => {
    render(<WorkPage data={work({ prompt: null })} />)
    expect(screen.getByText(m.studio_work_prompt_hidden())).toBeTruthy()
    expect(screen.queryByRole('button', { name: m.studio_work_copy() })).toBeNull()
  })

  it('视频作品使用原生播放器并显示时长；作者看到待审核说明', () => {
    const { container } = render(
      <WorkPage
        data={work({ kind: 'video', durationMs: 5_000, moderation: 'pending', isAuthor: true })}
      />,
    )
    const video = container.querySelector('video[controls]')
    expect(video?.getAttribute('src')).toBe(`/media/w/${ID}/3`)
    expect(screen.getByText(m.studio_work_duration())).toBeTruthy()
    expect(screen.getByText(m.studio_work_pending_notice())).toBeTruthy()
  })

  it('未找到', () => {
    render(<WorkNotFound />)
    expect(screen.getByRole('heading', { name: m.studio_work_not_found_title() })).toBeTruthy()
    expect(screen.getByText(m.studio_work_browse_gallery()).getAttribute('href')).toBe('/gallery')
  })
})

describe('举报', () => {
  it('登录用户：选原因后提交 JSON，不带人机验证令牌', async () => {
    api.context.mockResolvedValue({ signedIn: true, turnstileSiteKey: 'site-key' })
    api.fetch.mockResolvedValue(Response.json({ ok: true }))
    render(<WorkPage data={work()} />)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: m.studio_work_report() })[0] as Element)
    })
    const dialog = await screen.findByRole('dialog')
    const submit = within(dialog).getByRole('button', { name: m.studio_report_submit() })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    expect(within(dialog).queryByTestId('turnstile')).toBeNull()
    fireEvent.click(within(dialog).getByRole('radio', { name: m.studio_report_reason_copyright() }))
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: ' 抄袭 ' } })
    await act(async () => {
      fireEvent.click(submit)
    })
    expect(api.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = api.fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/studio/reports')
    expect(JSON.parse(String(init.body))).toEqual({ workId: ID, reason: 'copyright', note: '抄袭' })
    expect((init.headers as Record<string, string>)['x-turnstile-token']).toBeUndefined()
    expect(await within(dialog).findByText(m.studio_report_success())).toBeTruthy()
  })

  it('打开时判定已登录、提交时会话已失效（TURNSTILE_FAILED）：改为显示人机验证', async () => {
    api.context.mockResolvedValue({ signedIn: true, turnstileSiteKey: 'site-key' })
    api.fetch.mockResolvedValue(
      Response.json({ error: { code: 'TURNSTILE_FAILED' } }, { status: 403 }),
    )
    render(<WorkPage data={work()} />)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: m.studio_work_report() })[0] as Element)
    })
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByTestId('turnstile')).toBeNull()
    fireEvent.click(within(dialog).getByRole('radio', { name: m.studio_report_reason_spam() }))
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: m.studio_report_submit() }))
    })
    expect(await within(dialog).findByTestId('turnstile')).toBeTruthy()
  })

  it('未登录且未配置 Turnstile：提示登录后举报', async () => {
    api.context.mockResolvedValue({ signedIn: false, turnstileSiteKey: null })
    render(<WorkPage data={work()} />)
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: m.studio_work_report() })[0] as Element)
    })
    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(m.studio_report_sign_in_required())).toBeTruthy()
    expect(within(dialog).queryByRole('radiogroup')).toBeNull()
  })

  it('接口结果分类', async () => {
    expect(await reportOutcome(Response.json({ ok: true }))).toBe('ok')
    expect(await reportOutcome(new Response(null, { status: 429 }))).toBe('rate-limited')
    expect(
      await reportOutcome(Response.json({ error: { code: 'TURNSTILE_FAILED' } }, { status: 403 })),
    ).toBe('turnstile')
    expect(
      await reportOutcome(Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })),
    ).toBe('failed')
  })
})
