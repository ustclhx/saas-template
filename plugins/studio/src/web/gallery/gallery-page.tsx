// 公开画廊 /gallery（设计稿 media-studio/Gallery.dc.html、GalleryMobile.dc.html）：营销站外壳、类型与最新 / 精选筛选、
// CSS columns 瀑布流、可抓取的分页链接；空态与数据库不可达错误态。
import { Button, cn, Pagination } from '@saas/ui'
import { Link } from '@tanstack/react-router'
import { MarketingShell } from '@web/features/marketing/marketing-shell.tsx'
import { m } from '@web/paraglide/messages.js'
import type { ReactNode } from 'react'
import type { StudioKind } from '../../kinds.ts'
import type { GalleryPageData } from './gallery.functions.ts'
import { type GallerySearch, galleryHref } from './paths.ts'
import { WorkCard } from './work-card.tsx'

const segment = 'flex gap-0.5 rounded-lg bg-secondary p-0.5'
const segmentItem =
  'inline-flex h-9 items-center rounded-md px-3 text-caption font-medium text-muted-foreground transition-colors duration-80 hover:text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) aria-[current=page]:bg-card aria-[current=page]:text-foreground aria-[current=page]:shadow-surface-2 sm:h-7.5 sm:px-3.5'

function SegmentLink({
  href,
  current,
  children,
}: {
  href: string
  current: boolean
  children: ReactNode
}) {
  return (
    <a href={href} className={segmentItem} {...(current && { 'aria-current': 'page' as const })}>
      {children}
    </a>
  )
}

/** 筛选为普通链接：不依赖脚本，切换筛选回到第一页 */
function GalleryFilters({
  search,
  kinds,
}: {
  search: GallerySearch
  kinds: readonly StudioKind[]
}) {
  const sort = search.sort ? { sort: search.sort } : {}
  const kind = search.kind ? { kind: search.kind } : {}
  const kindLabel = {
    image: m.studio_gallery_filter_image(),
    video: m.studio_gallery_filter_video(),
  }
  return (
    <div className="flex items-center gap-2 sm:gap-3">
      {kinds.length > 1 && (
        <nav aria-label={m.studio_gallery_filter_kind()} className={segment}>
          <SegmentLink href={galleryHref(sort)} current={!search.kind}>
            {m.studio_gallery_filter_all()}
          </SegmentLink>
          {kinds.map((value) => (
            <SegmentLink
              key={value}
              href={galleryHref({ ...sort, kind: value })}
              current={search.kind === value}
            >
              {kindLabel[value]}
            </SegmentLink>
          ))}
        </nav>
      )}
      <nav
        aria-label={m.studio_gallery_filter_sort()}
        className={cn(segment, 'ml-auto hidden sm:flex')}
      >
        <SegmentLink href={galleryHref(kind)} current={!search.sort}>
          {m.studio_gallery_sort_latest()}
        </SegmentLink>
        <SegmentLink
          href={galleryHref({ ...kind, sort: 'featured' })}
          current={search.sort === 'featured'}
        >
          {m.studio_gallery_sort_featured()}
        </SegmentLink>
      </nav>
      {/* 手机：精选为单个切换链接（设计稿 GalleryMobile） */}
      <a
        href={galleryHref(search.sort ? kind : { ...kind, sort: 'featured' })}
        className={cn(segmentItem, 'ml-auto border border-border sm:hidden')}
        {...(search.sort && { 'aria-current': 'page' as const })}
      >
        {m.studio_gallery_sort_featured()}
      </a>
    </div>
  )
}

function GalleryHeader({ children }: { children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3.5 sm:gap-4">
      <div className="flex flex-col gap-1 sm:gap-1.5">
        <h1 className="font-semibold text-2xl tracking-tight sm:text-3xl">
          {m.studio_gallery_title()}
        </h1>
        <p className="text-caption text-muted-foreground sm:hidden">
          {m.studio_gallery_intro_short()}
        </p>
        <p className="hidden text-body text-muted-foreground sm:block">
          {m.studio_gallery_intro()}
        </p>
      </div>
      {children}
    </div>
  )
}

export function GalleryFrame({ children }: { children: ReactNode }) {
  return (
    <MarketingShell>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-3.5 px-4 pt-5 pb-10 sm:gap-5 sm:pt-8">
        {children}
      </div>
    </MarketingShell>
  )
}

function StateBox({ children, alert }: { children: ReactNode; alert?: boolean }) {
  return (
    <div
      {...(alert && { role: 'alert' })}
      className="flex flex-col items-center gap-2 rounded-xl border border-border px-4 py-16 text-center sm:gap-2.5 sm:px-6 sm:py-24"
    >
      {children}
    </div>
  )
}

export function GalleryEmpty({ filtered }: { filtered: boolean }) {
  return (
    <StateBox>
      <h2 className="font-semibold text-body">
        {filtered ? m.studio_gallery_empty_filtered_title() : m.studio_gallery_empty_title()}
      </h2>
      <p className="max-w-md text-caption text-muted-foreground sm:text-body">
        {filtered ? m.studio_gallery_empty_filtered_body() : m.studio_gallery_empty_body()}
      </p>
      {filtered ? (
        <Button asChild variant="outline" className="mt-2">
          <a href={galleryHref()}>{m.studio_gallery_view_all()}</a>
        </Button>
      ) : (
        <Button asChild className="mt-2">
          <Link to="/app">{m.studio_gallery_start_creating()}</Link>
        </Button>
      )}
    </StateBox>
  )
}

/** 数据库不可达等读取失败（响应 503、不缓存）：带站点导航的友好错误 */
export function GalleryUnavailable({ title }: { title?: string }) {
  return (
    <StateBox alert>
      <h2 className="font-semibold text-body">{title ?? m.studio_gallery_error_title()}</h2>
      <p className="max-w-md text-caption text-muted-foreground sm:text-body">
        {m.studio_gallery_error_body()}
      </p>
      <div className="mt-2 flex gap-2">
        <Button asChild variant="outline">
          <Link to="/">{m.studio_gallery_back_home()}</Link>
        </Button>
        <Button type="button" onClick={() => window.location.reload()}>
          {m.studio_gallery_refresh()}
        </Button>
      </div>
    </StateBox>
  )
}

export function GalleryErrorPage() {
  return (
    <GalleryFrame>
      <GalleryHeader />
      <GalleryUnavailable />
    </GalleryFrame>
  )
}

export function GalleryPage({ data, search }: { data: GalleryPageData; search: GallerySearch }) {
  const filtered = Boolean(search.kind || search.sort)
  const base = {
    ...(search.kind && { kind: search.kind }),
    ...(search.sort && { sort: search.sort }),
  }
  return (
    <GalleryFrame>
      <GalleryHeader>
        <GalleryFilters search={search} kinds={data.kinds} />
      </GalleryHeader>
      {data.works.length === 0 ? (
        <GalleryEmpty filtered={filtered} />
      ) : (
        <>
          <div className="columns-2 gap-2.5 sm:columns-3 sm:gap-4 lg:columns-4">
            {data.works.map((work, index) => (
              <WorkCard key={work.id} work={work} eager={index < 4} />
            ))}
          </div>
          {search.cursor === undefined && (
            <Pagination
              className="justify-center"
              page={data.page}
              pageCount={data.nextPage ?? data.page}
              hrefFor={(page) => galleryHref({ ...base, page })}
              labels={{
                nav: m.studio_gallery_pagination(),
                previous: m.studio_gallery_previous(),
                next: m.studio_gallery_next(),
                page: (page) => m.studio_gallery_page_n({ page }),
              }}
            />
          )}
          {/* 数值页最多 50 页，之后只提供「更早」游标链接（design 决策 4） */}
          {data.nextPage === null && data.nextCursor && (
            <div className="flex justify-center">
              <Button asChild variant="outline">
                <a href={galleryHref({ ...base, cursor: data.nextCursor })}>
                  {m.studio_gallery_older()}
                </a>
              </Button>
            </div>
          )}
        </>
      )}
    </GalleryFrame>
  )
}
