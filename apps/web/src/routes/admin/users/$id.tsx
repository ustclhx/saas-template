import { Button, DetailList, Input } from '@saas/ui'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { ADMIN_COPY } from '../../../features/admin/copy.ts'
import {
  AdminPage,
  AdminSection,
  CheckboxField,
  EmptyState,
  Field,
  formatDateTime,
  panelClass,
} from '../../../features/admin/ui.tsx'
import {
  getAdminUser,
  setAdminUserBan,
  startAdminImpersonation,
} from '../../../features/admin/users.functions.ts'
import { templateConfig } from '../../../server/template-config.ts'

export const Route = createFileRoute('/admin/users/$id')({
  loader: ({ params }) => getAdminUser({ data: { id: params.id } }),
  component: UserDetail,
})
function UserDetail() {
  const data = Route.useLoaderData()
  const { admin } = Route.useRouteContext()
  const router = useRouter()
  const [reason, setReason] = useState('')
  const [confirm, setConfirm] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function action(impersonate = false) {
    setBusy(true)
    try {
      if (impersonate) {
        await startAdminImpersonation({ data: { userId: data.user.id } })
        window.location.assign('/app')
      } else {
        await setAdminUserBan({ data: { userId: data.user.id, banned: !data.user.banned, reason } })
        setMessage(data.user.banned ? 'User unbanned.' : 'User banned.')
        setConfirm(false)
        setReason('')
        await router.invalidate()
      }
    } catch {
      setMessage('Operation failed. Reload to check the current state.')
    } finally {
      setBusy(false)
    }
  }
  const isAdminUser = (data.user.role ?? '').split(',').some((role) => role.trim() === 'admin')
  return (
    <AdminPage
      title="User details"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link to="/admin/users" search={{ offset: 0 }}>
            Back to users
          </Link>
        </Button>
      }
    >
      <DetailList
        fields={[
          { label: 'Email', value: data.user.email },
          { label: 'Name', value: data.user.name },
          { label: 'ID', value: data.user.id },
          { label: 'Registered', value: formatDateTime(data.user.createdAt) },
          { label: 'Login methods', value: data.methods.join(', ') || 'None' },
          { label: 'Ban status', value: data.user.banned ? 'Banned' : 'Active' },
          { label: 'Ban reason', value: data.user.banReason },
          {
            label: 'Ban expires',
            value: data.user.banExpires ? formatDateTime(data.user.banExpires) : 'No expiry',
          },
        ]}
      />
      <AdminSection title="Workspaces">
        {data.workspaces.length ? (
          <ul className="grid gap-2">
            {data.workspaces.map((ws) => (
              <li
                key={ws.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <span className="min-w-0 break-all">
                  <Link to="/admin/workspaces/$id" params={{ id: ws.id }} className="underline">
                    {ws.name}
                  </Link>{' '}
                  · {ws.role}
                </span>
                {templateConfig.credits.enabled && (
                  <Button asChild variant="outline" size="sm">
                    <Link
                      to="/admin/credits"
                      search={{ offset: 0, workspaceId: ws.id }}
                      aria-label={`${ADMIN_COPY.adjustCredits}: ${ws.name}`}
                    >
                      {ADMIN_COPY.adjustCredits}
                    </Link>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState />
        )}
      </AdminSection>
      <AdminSection title="Impersonation">
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={!ready || busy || isAdminUser || Boolean(data.user.banned)}
            onClick={() => void action(true)}
          >
            Impersonate user
          </Button>
          <p className="text-muted-foreground text-sm">
            Administrators and banned users cannot be impersonated.
          </p>
        </div>
      </AdminSection>
      <form
        className={panelClass('danger', 'max-w-xl')}
        aria-label="Ban management"
        onSubmit={(event) => {
          event.preventDefault()
          void action()
        }}
      >
        <div className="grid gap-1">
          <h3 className="font-semibold text-destructive text-lg">Ban management</h3>
          <p className="text-muted-foreground text-sm">
            {data.user.banned
              ? 'Restores sign-in for this user. The reason is recorded in the audit log.'
              : 'Signs the user out and blocks sign-in. The reason is recorded in the audit log.'}
          </p>
        </div>
        <Field label="Reason" htmlFor="ban-reason">
          <Input
            disabled={!ready}
            id="ban-reason"
            value={reason}
            maxLength={2000}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </Field>
        <CheckboxField
          label="I confirm this user status change"
          disabled={!ready}
          checked={confirm}
          onChange={(event) => setConfirm(event.target.checked)}
        />
        <Button
          type="submit"
          className="w-fit"
          variant={data.user.banned ? 'default' : 'destructive'}
          disabled={
            !ready ||
            busy ||
            !reason.trim() ||
            !confirm ||
            (!data.user.banned && data.user.id === admin.id)
          }
        >
          {data.user.banned ? 'Unban user' : 'Ban user'}
        </Button>
        {data.user.id === admin.id && (
          <p className="text-muted-foreground text-sm">You cannot ban yourself.</p>
        )}
      </form>
      <p role="status" className="min-h-5 text-sm">
        {message}
      </p>
    </AdminPage>
  )
}
