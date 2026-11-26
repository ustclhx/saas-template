import { createFileRoute, notFound } from '@tanstack/react-router'
import { m } from '@web/paraglide/messages.js'
import { templateConfig } from '@web/server/template-config.ts'
import { enabledStudioKinds, STUDIO_KINDS, type StudioKind } from '../../../../src/kinds.ts'
import { getStudioSubmitPage } from '../../../../src/web/submit.functions.ts'
import { type StudioSearch, StudioView } from '../../../../src/web/ui/studio-view.tsx'
import { getStudioWorks } from '../../../../src/web/works.functions.ts'

const text = (value: unknown, max: number) =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : undefined

export const Route = createFileRoute('/app/$slug/studio/')({
  // 「做同款」入口：?model=<key>&prompt=<文本>，?mode=image|video 指定模式。
  validateSearch: (search: Record<string, unknown>): StudioSearch => ({
    mode: STUDIO_KINDS.includes(search.mode as StudioKind)
      ? (search.mode as StudioKind)
      : undefined,
    model: text(search.model, 128),
    prompt: text(search.prompt, 2000),
  }),
  beforeLoad: ({ search }) => {
    // 未启用的模式与整页都返回 404（服务端接口同样拒绝）。
    const kinds = enabledStudioKinds(templateConfig)
    if (kinds.length === 0 || (search.mode && !kinds.includes(search.mode))) throw notFound()
  },
  loader: async ({ params }) => {
    const [page, recent] = await Promise.all([
      getStudioSubmitPage({ data: { slug: params.slug } }),
      // 最近作品条只是附加信息，读取失败时不影响创作。
      getStudioWorks({ data: { slug: params.slug, limit: 6 } }).catch(() => null),
    ])
    return { page, recent }
  },
  staleTime: 0,
  head: () => ({ meta: [{ title: m.studio_create() }] }),
  component: StudioPage,
})

function StudioPage() {
  const { page, recent } = Route.useLoaderData()
  const search = Route.useSearch()
  return <StudioView key={page.workspaceId} page={page} recent={recent} search={search} />
}
