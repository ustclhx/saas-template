import { Badge, Button, DataTable, type DataTableColumn, Tabs, TabsItem } from '@saas/ui'
import { Link, useNavigate } from '@tanstack/react-router'
import { adminListPage, offsetOfPage } from '@web/features/admin/list.ts'
import { AdminPage, adminTableLabels, formatDateTime, panelClass } from '@web/features/admin/ui.tsx'
import { m } from '@web/paraglide/messages.js'
import type { AdminConfirmationView, listAdminConfirmations } from './confirmations.functions.ts'
import { confirmationStatus, confirmationTitle, minutesUntil } from './confirmations-display.tsx'

/**
 * 待确认列表 `/admin/confirmations`（openspec add-admin-step-up 任务 4.3，设计稿
 * docs/design-system/prototypes/admin-step-up/Confirmations.dc.html 与 ConfirmationsMobile.dc.html）：
 * 待确认 / 历史两栏，桌面为 DataTable，手机为卡片列表。
 */

type Data = Awaited<ReturnType<typeof listAdminConfirmations>>
export type ConfirmationsView = 'pending' | 'history'

function statusOf(row: AdminConfirmationView, view: ConfirmationsView, now: number) {
  const status = confirmationStatus(row, now)
  if (view === 'pending' && status.state === 'open')
    return {
      label: m.admin_confirm_minutes_left({ minutes: minutesUntil(row.expiresAt, now) }),
      color: status.color,
    }
  return status
}

export function ConfirmationsPage({
  data,
  view,
  offset,
}: {
  data: Data
  view: ConfirmationsView
  offset: number
}) {
  const navigate = useNavigate()
  // 剩余时间按服务端读取时刻计算，服务端渲染与水合一致；刷新页面或切换分栏后更新
  const now = new Date(data.now).getTime()
  const tabs: ConfirmationsView[] = ['pending', 'history']
  const go = (next: { view: ConfirmationsView; offset: number }) =>
    void navigate({
      to: '/admin/confirmations',
      search:
        next.view === 'history'
          ? { view: 'history', offset: next.offset }
          : { offset: next.offset },
    })
  const columns: DataTableColumn<AdminConfirmationView>[] = [
    {
      id: 'action',
      header: m.admin_confirm_col_action(),
      cell: (row) => <span className="font-medium">{confirmationTitle(row)}</span>,
    },
    {
      id: 'tool',
      header: m.admin_confirm_col_tool(),
      cell: (row) => <span className="font-mono">{row.tool}</span>,
    },
    {
      id: 'token',
      header: m.admin_confirm_col_token(),
      cell: (row) => (
        <span>
          {row.token.name}{' '}
          <span className="font-mono text-muted-foreground">{row.token.prefix}…</span>
        </span>
      ),
    },
    {
      id: 'created',
      header: m.admin_confirm_col_created(),
      cell: (row) => <span className="text-muted-foreground">{formatDateTime(row.createdAt)}</span>,
    },
    {
      id: 'status',
      header: view === 'pending' ? m.admin_confirm_col_expiry() : m.admin_confirm_col_result(),
      cell: (row) => {
        const status = statusOf(row, view, now)
        return <Badge color={status.color}>{status.label}</Badge>
      },
    },
    {
      id: 'open',
      header: <span className="sr-only">{m.admin_confirm_col_open()}</span>,
      className: 'text-right',
      cell: (row) => (
        <Button asChild variant="outline" size="sm">
          <Link to="/admin/confirm/$id" params={{ id: row.id }}>
            {view === 'pending' ? m.admin_confirm_review() : m.admin_confirm_view()}
          </Link>
        </Button>
      ),
    },
  ]
  const empty = data.rows.length === 0 && offset === 0

  return (
    <AdminPage
      title={m.admin_confirm_list_title()}
      description={m.admin_confirm_list_description()}
    >
      <Tabs
        aria-label={m.admin_confirm_tabs_label()}
        selectedIndex={tabs.indexOf(view)}
        onSelect={(index) => go({ view: tabs[index] ?? 'pending', offset: 0 })}
        className="w-full self-start sm:w-fit"
      >
        <TabsItem
          index={0}
          className="flex-1"
          label={
            data.pending > 0
              ? m.admin_confirm_tab_pending({ count: data.pending })
              : m.admin_confirm_tab_pending_none()
          }
        />
        <TabsItem index={1} className="flex-1" label={m.admin_confirm_tab_history()} />
      </Tabs>
      {empty ? (
        <div className={panelClass('default', 'justify-items-center p-10 text-center')}>
          {view === 'pending' ? (
            <>
              <p className="font-semibold">{m.admin_confirm_empty_title()}</p>
              <p className="text-muted-foreground text-sm">{m.admin_confirm_empty_body()}</p>
            </>
          ) : (
            <p className="text-muted-foreground text-sm">{m.admin_confirm_history_empty()}</p>
          )}
        </div>
      ) : (
        <>
          <DataTable
            className="hidden md:flex"
            label={m.admin_confirm_table_label()}
            columns={columns}
            rows={data.rows}
            getRowId={(row) => row.id}
            page={adminListPage(offset, data)}
            onPageChange={(pageIndex) => go({ view, offset: offsetOfPage(pageIndex) })}
            labels={adminTableLabels()}
          />
          <ul className="grid gap-3 md:hidden" aria-label={m.admin_confirm_table_label()}>
            {data.rows.map((row) => {
              const status = statusOf(row, view, now)
              return (
                <li key={row.id}>
                  <Link
                    to="/admin/confirm/$id"
                    params={{ id: row.id }}
                    className={panelClass('default', 'gap-2 p-3 hover:bg-hover sm:p-3')}
                  >
                    <span className="font-medium">{confirmationTitle(row)}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-muted-foreground text-sm">{row.tool}</span>
                      <Badge color={status.color}>{status.label}</Badge>
                    </span>
                    <span className="text-muted-foreground text-sm">
                      {row.token.name} · {formatDateTime(row.createdAt)}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </AdminPage>
  )
}

/** 加载中：桌面骨架行、手机骨架卡片（设计稿 loading 状态） */
export function ConfirmationsSkeleton() {
  return (
    <AdminPage
      title={m.admin_confirm_list_title()}
      description={m.admin_confirm_list_description()}
    >
      <div className="grid gap-3" aria-busy="true">
        {[0, 1, 2].map((key) => (
          <div key={key} className={panelClass('default', 'gap-2')}>
            <div className="h-4 w-3/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-4 w-2/5 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </AdminPage>
  )
}

export function ConfirmationsError({ onRetry }: { onRetry: () => void }) {
  return (
    <AdminPage
      title={m.admin_confirm_list_title()}
      description={m.admin_confirm_list_description()}
    >
      <div role="alert" className={panelClass('default', 'justify-items-center p-10 text-center')}>
        <p className="font-semibold">{m.admin_confirm_load_failed()}</p>
        <p className="text-muted-foreground text-sm">{m.admin_confirm_load_failed_body()}</p>
        <Button type="button" variant="outline" onClick={onRetry}>
          {m.admin_confirm_retry()}
        </Button>
      </div>
    </AdminPage>
  )
}
