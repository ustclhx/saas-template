// 画廊瀑布流卡片（设计稿 media-studio/Gallery*.dc.html）：原生 img / video，显式宽高防布局抖动，懒加载。
import { Badge, cn } from '@saas/ui'
import { Link } from '@tanstack/react-router'
import { m } from '@web/paraglide/messages.js'
import type { StudioKind } from '../../kinds.ts'
import { studioMediaPath } from '../media-url.ts'
import { formatDuration } from './paths.ts'

export interface WorkCardData {
  id: string
  slug: string
  title: string
  kind: StudioKind
  width: number | null
  height: number | null
  durationMs: number | null
  version: number
  featuredAt?: string | null
}

/** 视频首帧：带 #t 片段让浏览器停在第一帧附近，preload="metadata" 不下载整段 */
function videoPreviewSrc(work: Pick<WorkCardData, 'id' | 'version'>) {
  return `${studioMediaPath(work.id, work.version)}#t=0.1`
}

export function WorkThumb({
  work,
  className,
  eager = false,
}: {
  work: WorkCardData
  className?: string
  eager?: boolean
}) {
  const size = work.width && work.height ? { width: work.width, height: work.height } : {}
  if (work.kind === 'video')
    return (
      <video
        src={videoPreviewSrc(work)}
        preload="metadata"
        muted
        playsInline
        aria-hidden="true"
        tabIndex={-1}
        {...size}
        className={cn('block h-auto w-full bg-muted', className)}
      />
    )
  return (
    <img
      src={studioMediaPath(work.id, work.version)}
      alt=""
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      {...size}
      className={cn('block h-auto w-full bg-muted', className)}
    />
  )
}

export function WorkCard({ work, eager }: { work: WorkCardData; eager?: boolean }) {
  const duration =
    work.kind === 'video' && work.durationMs !== null ? formatDuration(work.durationMs) : null
  return (
    <Link
      to="/gallery/$slug"
      params={{ slug: work.slug }}
      aria-label={
        duration ? `${work.title} · ${m.studio_gallery_video_label({ duration })}` : work.title
      }
      className="group mb-2.5 block break-inside-avoid rounded-xl outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring) sm:mb-4"
    >
      <span className="relative block overflow-hidden rounded-xl">
        <WorkThumb
          work={work}
          eager={eager ?? false}
          className="transition-opacity duration-150 group-hover:opacity-90"
        />
        {duration && (
          <span className="absolute right-2 bottom-2 rounded-full bg-background/80 px-2 text-caption text-foreground tabular-nums backdrop-blur-sm">
            {duration}
          </span>
        )}
        {work.featuredAt && (
          <Badge className="absolute top-2 left-2" color="gray">
            {m.studio_gallery_featured_badge()}
          </Badge>
        )}
      </span>
      <span className="hidden truncate px-0.5 pt-1.5 text-caption text-muted-foreground sm:block">
        {work.title}
      </span>
    </Link>
  )
}
