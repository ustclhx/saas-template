import { createFileRoute } from '@tanstack/react-router'
import { m } from '@web/paraglide/messages.js'
import { getMediaSubmitPage } from '../../../../src/web/ai-media/page.functions.ts'
import { MediaSubmitPage } from '../../../../src/web/ai-media/page.tsx'

export const Route = createFileRoute('/app/$slug/media/new')({
  loader: ({ params }) => getMediaSubmitPage({ data: { slug: params.slug } }),
  staleTime: 0,
  head: () => ({ meta: [{ title: m.media_title() }] }),
  component: MediaPage,
})

function MediaPage() {
  const page = Route.useLoaderData()
  return <MediaSubmitPage key={page.workspaceId} page={page} />
}
