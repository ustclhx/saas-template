import { createFileRoute, notFound } from '@tanstack/react-router'
import { m } from '@web/paraglide/messages.js'
import { templateConfig } from '@web/server/template-config.ts'
import { enabledStudioKinds, type StudioKind } from '../../../../src/kinds.ts'
import { type StudioWorksFilters, StudioWorksView } from '../../../../src/web/ui/works-view.tsx'
import { getStudioWorks } from '../../../../src/web/works.functions.ts'

export const Route = createFileRoute('/app/$slug/studio/works')({
  validateSearch: (search: Record<string, unknown>): StudioWorksFilters => {
    const kinds = enabledStudioKinds(templateConfig)
    return {
      kind: kinds.includes(search.kind as StudioKind) ? (search.kind as StudioKind) : undefined,
      visibility:
        search.visibility === 'public' || search.visibility === 'private'
          ? search.visibility
          : undefined,
    }
  },
  beforeLoad: () => {
    if (enabledStudioKinds(templateConfig).length === 0) throw notFound()
  },
  loaderDeps: ({ search }) => ({ kind: search.kind, visibility: search.visibility }),
  loader: ({ params, deps }) =>
    getStudioWorks({
      data: {
        slug: params.slug,
        ...(deps.kind && { kind: deps.kind }),
        ...(deps.visibility && { visibility: deps.visibility }),
      },
    }),
  staleTime: 0,
  head: () => ({ meta: [{ title: m.studio_my_works() }] }),
  component: WorksPage,
})

function WorksPage() {
  const page = Route.useLoaderData()
  const filters = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <StudioWorksView
      // 筛选变化时整页按新数据重新初始化（列表、游标与额度）
      key={`${page.workspaceId}:${filters.kind ?? ''}:${filters.visibility ?? ''}`}
      page={page}
      filters={filters}
      onFiltersChange={(next) =>
        void navigate({
          // 「全部」去掉对应参数，地址保持简短
          search: () => ({
            ...(next.kind && { kind: next.kind }),
            ...(next.visibility && { visibility: next.visibility }),
          }),
          replace: true,
        })
      }
    />
  )
}
