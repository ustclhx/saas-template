import { createFileRoute } from '@tanstack/react-router'
import { ADMIN_COPY } from '../../features/admin/copy.ts'

export const Route = createFileRoute('/admin/')({
  component: AdminOverview,
})

function AdminOverview() {
  return (
    <section>
      <h2>{ADMIN_COPY.overview.heading}</h2>
      <p>{ADMIN_COPY.overview.placeholder}</p>
    </section>
  )
}
