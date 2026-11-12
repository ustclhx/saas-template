import { Button, DataTable } from '@saas/ui'
import { useLocation, useRouter } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { adminListPage, offsetOfPage } from '../admin/list.ts'
import { dataTableLabels } from '../i18n/table-labels.ts'
import { getNotifications } from './notifications.functions.ts'
import { type NotificationPage, useNotifications } from './store.tsx'

/** 「查看全部通知」的落点：工作台首页 #notifications */
export const NOTIFICATION_CENTER_ID = 'notifications'

const EMPTY_PAGE: NotificationPage = { rows: [], unread: 0, hasMore: false }

/**
 * 工作台首页的通知区（完整列表与分页）。第一页与铃铛共用 NotificationsProvider 的数据和轮询；
 * 翻到后面的页时按需读取该页。地址带 #notifications 时自动展开并滚动到可见位置。
 * hideWhenEmpty：还没有任何通知时不渲染（侧边栏布局）。
 */
export function NotificationCenter({ hideWhenEmpty = false }: { hideWhenEmpty?: boolean }) {
  const router = useRouter()
  const { slug, status, page: firstPage, refresh, markRead } = useNotifications()
  const [offset, setOffset] = useState(0)
  const [laterPage, setLaterPage] = useState<NotificationPage | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  const detailsRef = useRef<HTMLDetailsElement | null>(null)

  const loadLaterPage = useCallback(async () => {
    if (offset === 0) return
    try {
      setLaterPage(await getNotifications({ data: { slug, offset } }))
      setError('')
    } catch {
      setError(m.notifications_unavailable())
    }
  }, [slug, offset])
  useEffect(() => {
    void loadLaterPage()
  }, [loadLaterPage])

  const page = (offset === 0 ? firstPage : laterPage) ?? EMPTY_PAGE
  const loadError = offset === 0 && status === 'error' ? m.notifications_unavailable() : ''
  const shownError = error || loadError
  const hidden =
    hideWhenEmpty && !shownError && page.unread === 0 && page.rows.length === 0 && offset === 0

  // 每次导航到 #notifications（包括已在首页时再次点击「查看全部」）都展开并滚动到通知区
  const hash = useLocation({ select: (location) => location.hash })
  const navigationKey = useLocation({ select: (location) => location.state.__TSR_key })
  useEffect(() => {
    void navigationKey
    if (hidden || hash !== NOTIFICATION_CENTER_ID) return
    setOpen(true)
    requestAnimationFrame(() => detailsRef.current?.scrollIntoView({ block: 'start' }))
  }, [hash, navigationKey, hidden])

  async function read(id?: string) {
    setBusy(true)
    try {
      const { link } = await markRead(id)
      await loadLaterPage()
      if (link) await router.navigate({ href: link })
    } catch {
      setError(m.notifications_action_failed())
    } finally {
      setBusy(false)
    }
  }

  if (hidden) return null
  return (
    <details
      ref={detailsRef}
      id={NOTIFICATION_CENTER_ID}
      open={open}
      className="scroll-mt-6"
      onToggle={(event) => {
        const next = event.currentTarget.open
        setOpen(next)
        if (next) void (offset === 0 ? refresh() : loadLaterPage())
      }}
    >
      <summary
        className="cursor-pointer"
        aria-label={m.notifications_center_summary({ count: page.unread })}
      >
        {m.notifications_title()} <span data-testid="notification-unread">{page.unread}</span>
      </summary>
      <section className="mt-3 grid gap-3" aria-label={m.notifications_center_label()}>
        <Button disabled={busy || page.unread === 0} onClick={() => void read()}>
          {m.notifications_mark_all_read()}
        </Button>
        {shownError ? <p role="alert">{shownError}</p> : null}
        <DataTable
          labels={dataTableLabels()}
          label={m.notifications_title()}
          rows={page.rows}
          getRowId={(row) => row.id}
          page={adminListPage(offset, page)}
          onPageChange={(index) => setOffset(offsetOfPage(index))}
          columns={[
            {
              id: 'notification',
              header: m.notifications_column(),
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
            {
              id: 'read',
              header: m.notifications_column_status(),
              cell: (row) =>
                row.readAt ? m.notifications_status_read() : m.notifications_status_unread(),
            },
          ]}
        />
      </section>
    </details>
  )
}
