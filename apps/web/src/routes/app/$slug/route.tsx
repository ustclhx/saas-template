import { createFileRoute, Outlet } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { withWorkspace } from '../../../server/middleware.ts'

// 空间页面的骨架（tasks.md 4.2）：不带样式，样式在 UI 基础合并后统一补。
// 文案先用英文硬编码，P6 接入 Paraglide。
const COPY = {
  title: (name: string) => `${name} · Workspace`,
  workspace: 'Workspace',
  personal: 'Personal workspace',
  team: 'Team workspace',
  role: 'Your role',
  signedInAs: 'Signed in as',
  notFoundTitle: 'Workspace not found',
  notFoundBody: 'This workspace does not exist or you do not have access to it.',
  backToApp: 'Go to my workspace',
} as const

// 每次进入（含客户端导航）都经 withWorkspace 在服务端查库校验成员身份；不是成员返回 404
const getWorkspace = createServerFn({ method: 'GET' })
  .middleware([withWorkspace])
  .handler(({ context: { user, workspace, member } }) => ({
    user: { id: user.id, name: user.name, email: user.email },
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      isPersonal: workspace.isPersonal,
    },
    member: { role: member.role },
  }))

export const Route = createFileRoute('/app/$slug')({
  loader: ({ params }) => getWorkspace({ data: { slug: params.slug } }),
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: COPY.title(loaderData.workspace.name) }] : [],
  }),
  component: WorkspaceLayout,
  notFoundComponent: WorkspaceNotFound,
})

function WorkspaceLayout() {
  const { user, workspace, member } = Route.useLoaderData()
  return (
    <>
      <header>
        <p>{COPY.workspace}</p>
        <h1 data-testid="workspace-name">{workspace.name}</h1>
        <dl>
          <dt>{workspace.isPersonal ? COPY.personal : COPY.team}</dt>
          <dd>{workspace.slug}</dd>
          <dt>{COPY.role}</dt>
          <dd>{member.role}</dd>
          <dt>{COPY.signedInAs}</dt>
          <dd data-testid="current-user">
            {user.name} ({user.email})
          </dd>
        </dl>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  )
}

function WorkspaceNotFound() {
  return (
    <main>
      <h1>{COPY.notFoundTitle}</h1>
      <p>{COPY.notFoundBody}</p>
      <a href="/app">{COPY.backToApp}</a>
    </main>
  )
}
