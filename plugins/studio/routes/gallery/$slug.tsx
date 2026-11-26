import { createFileRoute } from '@tanstack/react-router'
import { originFromMatches } from '@web/features/seo/metadata.ts'
import { m } from '@web/paraglide/messages.js'
import { getLocale } from '@web/paraglide/runtime.js'
import { getWorkPage } from '../../src/web/gallery/gallery.functions.ts'
import { noindexHead, workHead } from '../../src/web/gallery/gallery-seo.ts'
import { WorkErrorPage, WorkNotFound, WorkPage } from '../../src/web/gallery/work-page.tsx'

function workDescription(work: {
  title: string
  prompt: string | null
  kind: string
  displayName: string
}) {
  if (work.prompt) return work.prompt.length > 160 ? `${work.prompt.slice(0, 157)}…` : work.prompt
  const values = { title: work.title, model: work.displayName }
  return work.kind === 'video'
    ? m.studio_work_description_video(values)
    : m.studio_work_description_image(values)
}

/** 作品页（openspec add-media-studio 6.2）：未通过审核时 noindex；非公开、他站与不存在的作品 404 */
export const Route = createFileRoute('/gallery/$slug')({
  server: {
    handlers: {
      GET: async ({ request, next }) =>
        (await import('../../src/web/gallery/document.server.ts')).handleStudioDocument({
          request,
          next,
          route: 'work',
        }),
    },
  },
  loader: ({ params }) => getWorkPage({ data: { slug: params.slug } }),
  head: ({ matches, match, loaderData }) => {
    if (match.status === 'error') return noindexHead(m.studio_work_error_title())
    if (!loaderData) return noindexHead(m.studio_work_not_found_title())
    return workHead({
      work: loaderData.work,
      locale: getLocale(),
      appUrl: originFromMatches(matches),
      description: workDescription(loaderData.work),
    })
  },
  component: WorkRoute,
  notFoundComponent: WorkNotFound,
  errorComponent: WorkErrorPage,
})

function WorkRoute() {
  const data = Route.useLoaderData()
  return <WorkPage key={data.work.id} data={data} />
}
