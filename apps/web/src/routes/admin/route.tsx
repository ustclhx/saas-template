import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { getAdminViewer } from '../../features/admin/admin.functions.ts'
import { ADMIN_COPY } from '../../features/admin/copy.ts'
import { ADMIN_NAV } from '../../features/admin/nav.ts'

// 后台布局：守卫在 server function 中执行（requireFreshSession + admin 角色），
// 不满足时整个 /admin/** 返回 404（tasks.md 5.1）。
// 侧栏导航见 features/admin/nav.ts（add-admin-console tasks.md 1.3）。
export const Route = createFileRoute('/admin')({
  beforeLoad: async () => ({ admin: await getAdminViewer() }),
  head: () => ({ meta: [{ title: ADMIN_COPY.title }] }),
  component: AdminLayout,
})

function AdminLayout() {
  const { admin } = Route.useRouteContext()
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="flex flex-col gap-4 border-b bg-muted/30 p-4 md:w-56 md:shrink-0 md:border-r md:border-b-0">
        <header className="flex flex-col gap-1">
          <h1 className="font-semibold text-lg">{ADMIN_COPY.heading}</h1>
          <p className="break-all text-muted-foreground text-xs">
            {ADMIN_COPY.signedInAs} {admin.email}
          </p>
        </header>
        <nav aria-label={ADMIN_COPY.nav.label}>
          <ul className="flex flex-wrap gap-1 md:flex-col">
            {ADMIN_NAV.map(({ label, ...link }) => (
              <li key={link.to}>
                <Link
                  {...link}
                  className="block rounded-md px-3 py-1.5 text-sm hover:bg-accent"
                  activeProps={{ className: 'bg-accent font-medium', 'aria-current': 'page' }}
                >
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <Link to="/app" className="mt-auto text-muted-foreground text-sm underline">
          {ADMIN_COPY.backToApp}
        </Link>
      </aside>
      <main className="min-w-0 flex-1 p-6">
        <Outlet />
      </main>
    </div>
  )
}
