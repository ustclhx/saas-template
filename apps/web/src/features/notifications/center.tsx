import { Button, DataTable } from '@saas/ui'
import { useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { adminListPage, offsetOfPage } from '../admin/list.ts'
import { dataTableLabels } from '../i18n/table-labels.ts'
import { getNotifications, readNotifications } from './notifications.functions.ts'

type NotificationPage = Awaited<ReturnType<typeof getNotifications>>

/** hideWhenEmpty：还没有任何通知时不渲染（工作台布局；铃铛弹层另行实现） */
export function NotificationCenter({
  slug,
  hideWhenEmpty = false,
}: {
  slug: string
  hideWhenEmpty?: boolean
}) {
  const router = useRouter()
  const [page, setPage] = useState<NotificationPage>({ rows: [], unread: 0, hasMore: false })
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(async () => {
    try {
      setPage(await getNotifications({ data: { slug, offset } }))
      setError('')
    } catch {
      // 通知读取失败只降级入口，不阻止应用布局使用。
      setError('Notifications unavailable. Try refreshing.')
    }
  }, [slug, offset])
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 30000)
    return () => clearInterval(timer)
  }, [refresh])

  async function read(id?: string) {
    setBusy(true)
    try {
      const { link } = await readNotifications({ data: { slug, ...(id ? { id } : {}) } })
      await refresh()
      if (link) await router.navigate({ href: link })
    } catch {
      setError('Could not mark notifications read. Please retry.')
    } finally {
      setBusy(false)
    }
  }

  if (hideWhenEmpty && !error && page.unread === 0 && page.rows.length === 0 && offset === 0)
    return null
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open) void refresh()
      }}
    >
      <summary className="cursor-pointer" aria-label={`Notifications (${page.unread} unread)`}>
        Notifications <span data-testid="notification-unread">{page.unread}</span>
      </summary>
      <section className="mt-3 grid gap-3" aria-label="Notification center">
        <Button disabled={busy || page.unread === 0} onClick={() => void read()}>
          Mark all read
        </Button>
        {error ? <p role="alert">{error}</p> : null}
        <DataTable
          labels={dataTableLabels()}
          label="Notifications"
          rows={page.rows}
          getRowId={(row) => row.id}
          page={adminListPage(offset, page)}
          onPageChange={(index) => setOffset(offsetOfPage(index))}
          columns={[
            {
              id: 'notification',
              header: 'Notification',
              cell: (row) => (
                <div>
                  <button
                    type="button"
                    className="text-left underline"
                    disabled={busy}
                    onClick={() => void read(row.id)}
                  >
                    {row.title}
                  </button>
                  {row.body ? <p>{row.body}</p> : null}
                </div>
              ),
            },
            { id: 'read', header: 'Status', cell: (row) => (row.readAt ? 'Read' : 'Unread') },
          ]}
        />
      </section>
    </details>
  )
}
