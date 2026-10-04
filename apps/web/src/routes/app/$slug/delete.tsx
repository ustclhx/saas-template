import { createFileRoute, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { DeletionSection } from '../../../features/deletion/deletion-section.tsx'
import { withWorkspace } from '../../../server/middleware.ts'
import { templateConfig } from '../../../server/template-config.ts'

const getDeletionWorkspace = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .handler(({ context: { workspace, member } }) => {
    if (workspace.isPersonal || member.role !== 'owner' || !templateConfig.tenancy.multiTenant)
      throw notFound()
    return { id: workspace.id, name: workspace.name }
  })
export const Route = createFileRoute('/app/$slug/delete')({
  loader: ({ params }) => getDeletionWorkspace({ data: { slug: params.slug } }),
  component: DeleteWorkspacePage,
})
function DeleteWorkspacePage() {
  return <DeletionSection workspace={Route.useLoaderData()} />
}
