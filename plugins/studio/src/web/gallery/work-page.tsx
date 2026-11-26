// 作品页 /gallery/$slug（设计稿 media-studio/Work.dc.html、WorkMobile.dc.html）：媒体、标题、模型显示名、尺寸或时长、
// 发布日期、提示词或未公开说明、做同款、复制链接、举报、相关作品；未找到与错误态。
import { Alert, AlertDescription, Breadcrumb, Button, cn } from '@saas/ui'
import { Copy, Link2 } from '@saas/ui/icons'
import { Link } from '@tanstack/react-router'
import { m } from '@web/paraglide/messages.js'
import { useEffect, useState } from 'react'
import { studioMediaPath } from '../media-url.ts'
import type { PublicWork, WorkPageData } from './gallery.functions.ts'
import { GalleryFrame, GalleryUnavailable } from './gallery-page.tsx'
import { formatPublishedDate, remixPath } from './paths.ts'
import { ReportDialog } from './report-dialog.tsx'
import { WorkThumb } from './work-card.tsx'

function sizeText(work: PublicWork) {
  if (work.kind === 'video') {
    const seconds =
      work.durationMs !== null
        ? m.studio_work_seconds({ count: Math.round(work.durationMs / 1000) })
        : null
    const dims = work.width && work.height ? `${work.width} × ${work.height}` : null
    return [seconds, dims].filter(Boolean).join(' · ')
  }
  return work.width && work.height ? `${work.width} × ${work.height}` : ''
}

/** 复制到剪贴板，按钮显示「已复制」两秒 */
function useCopied(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  return [
    copied,
    (key, text) => {
      void navigator.clipboard?.writeText(text).then(
        () => setCopied(key),
        () => setCopied(null),
      )
    },
  ]
}

function WorkMedia({ work }: { work: PublicWork }) {
  const size = work.width && work.height ? { width: work.width, height: work.height } : {}
  if (work.kind === 'video')
    return (
      <video
        src={studioMediaPath(work.id, work.version)}
        controls
        playsInline
        preload="metadata"
        aria-label={work.title}
        {...size}
        className="block h-auto max-h-120 w-full rounded-xl bg-muted object-contain md:max-h-130"
      />
    )
  return (
    <img
      src={studioMediaPath(work.id, work.version)}
      alt={work.title}
      {...size}
      className="block h-auto max-h-120 w-full rounded-xl bg-muted object-contain md:max-h-130"
    />
  )
}

export function WorkPage({ data }: { data: WorkPageData }) {
  const { work, related } = data
  const [copied, copy] = useCopied()
  const [reportOpen, setReportOpen] = useState(false)
  const size = sizeText(work)
  const remix = remixPath(work.slug)
  const copyLink = () => copy('link', window.location.href.split(/[?#]/)[0] ?? window.location.href)
  const reportButton = (
    <Button
      type="button"
      variant="ghost"
      className="text-muted-foreground"
      onClick={() => setReportOpen(true)}
    >
      {m.studio_work_report()}
    </Button>
  )
  return (
    <GalleryFrame>
      <Breadcrumb
        label={m.studio_work_breadcrumb()}
        items={[{ label: m.studio_gallery_title(), href: '/gallery' }]}
        current={work.title}
        renderLink={({ href, ...props }) => <Link to={href} {...props} />}
      />
      {work.isAuthor && work.moderation !== 'approved' && (
        <Alert>
          <AlertDescription>{m.studio_work_pending_notice()}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-col gap-3.5 md:flex-row md:items-start md:gap-8">
        <div className="min-w-0 md:flex-1">
          <WorkMedia work={work} />
        </div>
        <aside className="flex flex-col gap-3.5 md:w-90 md:shrink-0 md:gap-4.5">
          <h1 className="font-semibold text-xl tracking-tight md:text-2xl">{work.title}</h1>
          {/* 手机：元信息合为一行（设计稿 WorkMobile） */}
          <p className="text-caption text-muted-foreground md:hidden">
            {[work.displayName, size, formatPublishedDate(work.publishedAt)]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <dl className="hidden flex-col gap-2 text-body md:flex">
            <div className="flex gap-4">
              <dt className="w-16 shrink-0 text-muted-foreground">{m.studio_work_model()}</dt>
              <dd className="min-w-0 break-words">{work.displayName}</dd>
            </div>
            {size && (
              <div className="flex gap-4">
                <dt className="w-16 shrink-0 text-muted-foreground">
                  {work.kind === 'video' ? m.studio_work_duration() : m.studio_work_size()}
                </dt>
                <dd className="tabular-nums">{size}</dd>
              </div>
            )}
            <div className="flex gap-4">
              <dt className="w-16 shrink-0 text-muted-foreground">{m.studio_work_published()}</dt>
              <dd className="tabular-nums">{formatPublishedDate(work.publishedAt)}</dd>
            </div>
          </dl>
          <section className="flex flex-col gap-1.5 rounded-xl bg-secondary p-3 md:gap-2 md:p-3.5">
            <div className="flex min-h-8 items-center">
              <h2 className="flex-1 font-medium text-caption">{m.studio_work_prompt()}</h2>
              {work.prompt && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  leadingIcon={Copy}
                  onClick={() => copy('prompt', work.prompt ?? '')}
                >
                  {copied === 'prompt' ? m.studio_work_copied() : m.studio_work_copy()}
                </Button>
              )}
            </div>
            <p
              className={cn(
                'whitespace-pre-wrap break-words text-body',
                !work.prompt && 'text-muted-foreground',
              )}
            >
              {work.prompt ?? m.studio_work_prompt_hidden()}
            </p>
          </section>
          {/* 桌面操作区 */}
          <div className="hidden flex-col gap-2 md:flex">
            <Button asChild size="lg" className="h-11">
              <a href={remix} rel="nofollow">
                {m.studio_work_remix()}
              </a>
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                leadingIcon={Link2}
                onClick={copyLink}
              >
                {copied === 'link' ? m.studio_work_link_copied() : m.studio_work_copy_link()}
              </Button>
              {reportButton}
            </div>
          </div>
          {/* 手机操作栏（44px 触控目标） */}
          <div className="flex gap-2 md:hidden">
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="size-11"
              aria-label={
                copied === 'link' ? m.studio_work_link_copied() : m.studio_work_copy_link()
              }
              leadingIcon={Link2}
              onClick={copyLink}
            />
            <Button
              type="button"
              variant="ghost"
              className="h-11 text-muted-foreground"
              onClick={() => setReportOpen(true)}
            >
              {m.studio_work_report()}
            </Button>
            <Button asChild className="h-11 flex-1">
              <a href={remix} rel="nofollow">
                {m.studio_work_remix()}
              </a>
            </Button>
          </div>
        </aside>
      </div>
      {related.length > 0 && (
        <section
          aria-labelledby="studio-related-title"
          className="flex flex-col gap-3"
          data-link-zone="related"
        >
          <div className="flex items-center">
            <h2 id="studio-related-title" className="flex-1 font-semibold text-body">
              {m.studio_work_related()}
            </h2>
            <Link
              to="/gallery"
              className="text-caption text-muted-foreground hover:text-foreground"
            >
              {m.studio_work_back_to_gallery()}
            </Link>
          </div>
          <ul className="grid grid-cols-3 gap-2.5 sm:grid-cols-6 sm:gap-3">
            {related.map((item) => (
              <li key={item.id}>
                <Link
                  to="/gallery/$slug"
                  params={{ slug: item.slug }}
                  aria-label={item.title}
                  className="block overflow-hidden rounded-xl outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)"
                >
                  <WorkThumb work={item} className="aspect-square object-cover" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ReportDialog workId={work.id} open={reportOpen} onOpenChange={setReportOpen} />
    </GalleryFrame>
  )
}

export function WorkNotFound() {
  return (
    <GalleryFrame>
      <div className="flex flex-col items-center gap-2.5 py-20 text-center sm:py-28">
        <span className="text-caption text-muted-foreground">404</span>
        <h1 className="font-semibold text-xl md:text-2xl">{m.studio_work_not_found_title()}</h1>
        <p className="max-w-md text-body text-muted-foreground">{m.studio_work_not_found_body()}</p>
        <Button asChild className="mt-2">
          <Link to="/gallery">{m.studio_work_browse_gallery()}</Link>
        </Button>
      </div>
    </GalleryFrame>
  )
}

export function WorkErrorPage() {
  return (
    <GalleryFrame>
      <GalleryUnavailable title={m.studio_work_error_title()} />
    </GalleryFrame>
  )
}
