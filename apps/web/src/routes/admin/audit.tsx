import { DataTable } from '@saas/ui'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { getAdminAuditLogs } from '../../features/admin/audit.functions.ts'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../features/admin/list.ts'

const filters = ['actor', 'workspaceId', 'action', 'from', 'to'] as const
export const Route = createFileRoute('/admin/audit')({
  validateSearch: (search: Record<string, unknown>) => adminListSearch(filters)(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminAuditLogs({ data: deps }),
  component: Audit,
})
function Audit() {
  // SSR 按钮在水合完成前不可交互，避免首次点击丢失。
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <section className="grid gap-5">
      <h2 className="font-semibold text-xl">Audit log</h2>
      <p className="text-muted-foreground text-sm">
        Dates use UTC and include both selected days. Records are read only.
      </p>
      <fieldset disabled={!ready} className="min-w-0">
        <DataTable
          label="Audit log"
          rows={data.rows}
          getRowId={(row) => row.log.id}
          columns={[
            { id: 'at', header: 'Time (UTC)', cell: ({ log }) => log.createdAt.toISOString() },
            {
              id: 'actor',
              header: 'Actor',
              cell: ({ log, actorEmail }) => (
                <span>
                  {actorEmail ?? log.actorUserId ?? 'System'}
                  <br />
                  {log.actorUserId}
                </span>
              ),
            },
            { id: 'space', header: 'Workspace', cell: ({ log }) => log.workspaceId ?? '—' },
            { id: 'action', header: 'Action', cell: ({ log }) => log.action },
            {
              id: 'target',
              header: 'Target',
              cell: ({ log }) => `${log.targetType ?? ''} ${log.targetId ?? ''}`,
            },
            { id: 'ip', header: 'Source IP', cell: ({ log }) => log.ip ?? '—' },
            {
              id: 'meta',
              header: 'Details',
              cell: ({ log }) => (
                <details>
                  <summary>View details</summary>
                  <pre className="max-w-sm whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(log.meta, null, 2)}
                  </pre>
                </details>
              ),
            },
          ]}
          page={adminListPage(search.offset, data)}
          filters={[
            { id: 'actor', label: 'Actor', placeholder: 'User ID or email / actual admin ID' },
            { id: 'workspaceId', label: 'Workspace ID' },
            { id: 'action', label: 'Action' },
            { id: 'from', label: 'From (UTC)', placeholder: 'YYYY-MM-DD' },
            { id: 'to', label: 'To (UTC)', placeholder: 'YYYY-MM-DD' },
          ]}
          filterValues={{
            actor: search.actor,
            workspaceId: search.workspaceId,
            action: search.action,
            from: search.from,
            to: search.to,
          }}
          onPageChange={(page) =>
            void navigate({ search: { ...search, offset: offsetOfPage(page) } })
          }
          onFiltersChange={(values) => void navigate({ search: filtersToSearch(filters, values) })}
        />
      </fieldset>
    </section>
  )
}
