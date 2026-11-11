import { Button, DataTable } from '@saas/ui'
import { createFileRoute, notFound as featureNotFound, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { deleteAdminFeedback, getAdminFeedback } from '../../features/admin/feedback.functions.ts'
import type { SatisfactionRow } from '../../features/admin/feedback.ts'
import {
  adminListPage,
  adminListSearch,
  filtersToSearch,
  offsetOfPage,
} from '../../features/admin/list.ts'
import { AdminPage, adminTableLabels, formatDateTime, Panel } from '../../features/admin/ui.tsx'
import { feedbackReasonLabel } from '../../features/ai/chat-extras.tsx'
import { FEEDBACK_REASONS } from '../../features/ai/feedback.ts'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'

const filters = ['rating', 'reason', 'model', 'subjectType', 'from', 'to'] as const

export const Route = createFileRoute('/admin/feedback')({
  beforeLoad: () => {
    if (!templateConfig.billing.enabled) throw featureNotFound()
  },
  validateSearch: (search: Record<string, unknown>) => adminListSearch(filters)(search),
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAdminFeedback({ data: deps }),
  component: FeedbackAdmin,
})

const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`
const subjectName = (key: string | null) =>
  key === null || key === '-' ? m.admin_feedback_no_subject() : key

function StatsTable({ title, rows }: { title: string; rows: readonly SatisfactionRow[] }) {
  return (
    <Panel className="grid gap-2">
      <h2 className="font-medium">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{m.admin_feedback_no_ratings()}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 font-medium">{title}</th>
              <th className="py-1 font-medium">{m.admin_feedback_up()}</th>
              <th className="py-1 font-medium">{m.admin_feedback_down()}</th>
              <th className="py-1 font-medium">{m.admin_feedback_satisfaction()}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t">
                <td className="py-1 break-all">{subjectName(row.key)}</td>
                <td className="py-1">{row.up}</td>
                <td className="py-1">{row.down}</td>
                <td className="py-1">{percent(row.rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

function FeedbackAdmin() {
  // SSR 按钮在水合完成前不可交互，避免首次点击丢失。
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const data = Route.useLoaderData()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  async function remove(id: string) {
    setBusy(id)
    try {
      await deleteAdminFeedback({ data: { id } })
      setMessage(m.admin_feedback_deleted())
      await router.invalidate()
    } catch {
      setMessage(m.admin_feedback_delete_failed())
    } finally {
      setBusy(null)
    }
  }

  return (
    <AdminPage
      title={m.admin_feedback_title()}
      description={m.admin_feedback_description({ from: data.stats.from, to: data.stats.to })}
    >
      <div className="grid gap-4 md:grid-cols-2">
        <StatsTable title={m.admin_feedback_by_model()} rows={data.stats.byModel} />
        <StatsTable title={m.admin_feedback_by_subject()} rows={data.stats.bySubject} />
      </div>
      <p role="status" className="min-h-5 text-sm">
        {message}
      </p>
      <fieldset disabled={!ready} className="min-w-0">
        <DataTable
          labels={adminTableLabels()}
          label={m.admin_feedback_title()}
          rows={data.rows}
          getRowId={(row) => row.id}
          columns={[
            { id: 'at', header: m.admin_time_utc(), cell: (row) => formatDateTime(row.createdAt) },
            { id: 'space', header: m.admin_workspace(), cell: (row) => row.workspaceId },
            { id: 'model', header: m.admin_feedback_model(), cell: (row) => row.modelKey ?? '—' },
            {
              id: 'subject',
              header: m.admin_feedback_subject(),
              cell: (row) => subjectName(row.subjectType),
            },
            {
              id: 'rating',
              header: m.admin_feedback_rating(),
              cell: (row) =>
                row.rating === 'up' ? m.admin_feedback_up() : m.admin_feedback_down(),
            },
            {
              id: 'reason',
              header: m.admin_feedback_reason(),
              cell: (row) => (row.reason ? feedbackReasonLabel(row.reason) : '—'),
            },
            {
              id: 'comment',
              header: m.admin_feedback_comment(),
              cell: (row) => (
                <p className="max-w-sm whitespace-pre-wrap break-words">{row.comment ?? '—'}</p>
              ),
            },
            {
              id: 'message',
              header: m.admin_feedback_message_id(),
              cell: (row) => <code className="text-xs">{row.messageId}</code>,
            },
            {
              id: 'actions',
              header: m.admin_feedback_actions(),
              cell: (row) => (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void remove(row.id)}
                >
                  {m.admin_feedback_delete()}
                </Button>
              ),
            },
          ]}
          page={adminListPage(search.offset, data)}
          filters={[
            { id: 'rating', label: m.admin_feedback_rating(), placeholder: 'up / down' },
            {
              id: 'reason',
              label: m.admin_feedback_reason(),
              type: 'select',
              options: [
                { value: '', label: m.admin_all() },
                ...FEEDBACK_REASONS.map((reason) => ({
                  value: reason,
                  label: feedbackReasonLabel(reason),
                })),
              ],
            },
            { id: 'model', label: m.admin_feedback_model() },
            {
              id: 'subjectType',
              label: m.admin_feedback_subject(),
              placeholder: m.admin_feedback_subject_placeholder(),
            },
            { id: 'from', label: m.admin_from_utc(), placeholder: 'YYYY-MM-DD' },
            { id: 'to', label: m.admin_to_utc(), placeholder: 'YYYY-MM-DD' },
          ]}
          filterValues={{
            rating: search.rating,
            reason: search.reason,
            model: search.model,
            subjectType: search.subjectType,
            from: search.from,
            to: search.to,
          }}
          onPageChange={(page) =>
            void navigate({ search: { ...search, offset: offsetOfPage(page) } })
          }
          onFiltersChange={(values) => void navigate({ search: filtersToSearch(filters, values) })}
        />
      </fieldset>
    </AdminPage>
  )
}
