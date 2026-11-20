import { LinkCardGrid } from '@saas/ui'
import { Link } from '@tanstack/react-router'
import { m } from '../../../paraglide/messages.js'
import { getLocale } from '../../../paraglide/runtime.js'
import { routerLink } from '../page-links.tsx'

export interface PostSummary {
  readonly slug: string
  readonly title: string
  readonly summary: string
  readonly date: string
  readonly tags: readonly string[]
  readonly draft: boolean
}

export function formatDate(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(date),
  )
}

export function TagLinks({ tags }: { tags: readonly string[] }) {
  return (
    <ul className="flex flex-wrap gap-2">
      {tags.map((tag) => (
        <li key={tag}>
          <Link
            to="/blog/tags/$tag"
            params={{ tag }}
            className="rounded-full border px-2.5 py-0.5 text-muted-foreground text-xs hover:text-foreground"
          >
            {tag}
          </Link>
        </li>
      ))}
    </ul>
  )
}

/**
 * hub 列表（openspec seo-internal-linking 3.2，设计稿 seo-internal-linking/Hub.dc.html）：桌面两列卡片，
 * 标题即文章主词（titleMain 默认取标题），整张卡片是一个链接；链接按正文统计（不加区域标记）。
 */
export function PostList({ posts }: { posts: readonly PostSummary[] }) {
  const locale = getLocale()
  if (posts.length === 0) return <p className="text-muted-foreground">{m.marketing_blog_empty()}</p>
  return (
    <LinkCardGrid
      columns={2}
      zone={null}
      renderLink={routerLink}
      items={posts.map((post) => ({
        href: `/blog/${encodeURIComponent(post.slug)}`,
        title: post.title,
        eyebrow: (
          <>
            <time dateTime={post.date}>{formatDate(post.date, locale)}</time>
            {post.draft && ` · ${m.marketing_blog_draft()}`}
          </>
        ),
        description: post.summary,
      }))}
    />
  )
}
