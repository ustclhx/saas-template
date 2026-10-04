import { createFileRoute } from '@tanstack/react-router'
import { WorkspaceSettings } from '../../../features/workspace/components.tsx'
import { getWorkspacePage } from '../../../features/workspace/workspace.functions.ts'

export const Route = createFileRoute('/app/$slug/settings')({
  beforeLoad: async ({ params }) => ({
    workspacePage: await getWorkspacePage({ data: { slug: params.slug } }),
  }),
  loader: ({ context }) => context.workspacePage,
  staleTime: 0,
  component: () => <WorkspaceSettings page={Route.useLoaderData()} />,
})
