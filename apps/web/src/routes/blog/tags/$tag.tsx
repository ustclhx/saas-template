import { createFileRoute, Link } from '@tanstack/react-router'
import { PostList } from '../../../features/marketing/blog/post-list.tsx'
import { getBlogIndex } from '../../../features/marketing/content.functions.ts'
import { MarketingShell } from '../../../features/marketing/marketing-shell.tsx'
import { m } from '../../../paraglide/messages.js'
import { getLocale } from '../../../paraglide/runtime.js'

export const Route = createFileRoute('/blog/tags/$tag')({
  loader: ({ params }) => getBlogIndex({ data: { locale: getLocale(), tag: params.tag } }),
  head: ({ params }) => ({ meta: [{ title: m.marketing_blog_tag_title({ tag: params.tag }) }] }),
  component: BlogTagPage,
})

function BlogTagPage() {
  const { tag } = Route.useParams()
  const { posts } = Route.useLoaderData()
  return (
    <MarketingShell>
      <div className="mx-auto grid max-w-3xl gap-10 px-4 py-16">
        <header className="grid gap-3">
          <h1 className="font-bold text-3xl tracking-tight">
            {m.marketing_blog_tag_title({ tag })}
          </h1>
          <Link to="/blog" className="text-muted-foreground text-sm hover:text-foreground">
            ← {m.marketing_blog_all_posts()}
          </Link>
        </header>
        <PostList posts={posts} />
      </div>
    </MarketingShell>
  )
}
