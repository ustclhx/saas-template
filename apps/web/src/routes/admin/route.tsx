import { createFileRoute, Link, Outlet } from '@tanstack/react-router'
import { getAdminViewer } from '../../features/admin/admin.functions.ts'
import { ADMIN_COPY } from '../../features/admin/copy.ts'

// 后台布局：守卫在 server function 中执行（requireFreshSession + admin 角色），
// 不满足时整个 /admin/** 返回 404（tasks.md 5.1）
export const Route = createFileRoute('/admin')({
  beforeLoad: async () => ({ admin: await getAdminViewer() }),
  head: () => ({ meta: [{ title: ADMIN_COPY.title }] }),
  component: AdminLayout,
})

function AdminLayout() {
  const { admin } = Route.useRouteContext()
  return (
    <div>
      <header>
        <h1>{ADMIN_COPY.heading}</h1>
        <p>
          {ADMIN_COPY.signedInAs} {admin.email}
        </p>
        <nav aria-label={ADMIN_COPY.nav.label}>
          <ul>
            <li>
              <Link to="/admin">{ADMIN_COPY.nav.overview}</Link>
            </li>
            <li>
              <Link to="/admin/billing" search={{ offset: 0 }}>
                Billing
              </Link>
            </li>
            <li>
              <Link to="/admin/billing/refunds" search={{ offset: 0 }}>
                Refund reviews
              </Link>
            </li>
            <li>
              <Link to="/admin/models">Models</Link>
            </li>
          </ul>
        </nav>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
