import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { WorkspaceSwitcher } from '../../../features/workspace/components.tsx'
import { getWorkspacePage } from '../../../features/workspace/workspace.functions.ts'

export const Route = createFileRoute('/app/$slug')({
  beforeLoad: async ({ params }) => ({
    workspacePage: await getWorkspacePage({ data: { slug: params.slug } }),
  }),
  loader: ({ context }) => context.workspacePage,
  staleTime: 0,
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: `${loaderData.workspace.name} · Workspace` }] : [],
  }),
  component: WorkspaceLayout,
  notFoundComponent: () => (
    <main>
      <h1>Workspace not found</h1>
      <p>This workspace does not exist or you do not have access to it.</p>
      <a href="/app">Go to my workspace</a>
    </main>
  ),
})

function WorkspaceLayout() {
  const page = Route.useLoaderData()
  return (
    <div className="mx-auto grid max-w-4xl gap-8 p-6">
      <header className="grid gap-4">
        <h1 data-testid="workspace-name" className="text-2xl font-semibold">
          {page.workspace.name}
        </h1>
        <p>{page.workspace.isPersonal ? 'Personal workspace' : 'Team workspace'}</p>
        <p>Your role: {page.role}</p>
        <p data-testid="current-user">
          {page.user.name} ({page.user.email})
        </p>
        {page.readOnly ? (
          <p role="status">Team features are disabled. This workspace is read-only.</p>
        ) : null}
        <WorkspaceSwitcher page={page} />
        <nav>
          <Link
            to="/app/$slug/settings"
            params={{ slug: page.workspace.slug }}
            className="underline"
          >
            Workspace settings
          </Link>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
