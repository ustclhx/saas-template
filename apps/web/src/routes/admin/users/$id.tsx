import { Button, DetailList, Input } from '@saas/ui'
import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  getAdminUser,
  setAdminUserBan,
  startAdminImpersonation,
} from '../../../features/admin/users.functions.ts'

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
  return (
    <section className="grid gap-5">
      <Link to="/admin/users" search={{ offset: 0 }} className="underline">
        Back to users
      </Link>
      <h2 className="font-semibold text-xl">User details</h2>
      <DetailList
        fields={[
          { label: 'Email', value: data.user.email },
          { label: 'Name', value: data.user.name },
          { label: 'ID', value: data.user.id },
          { label: 'Registered', value: data.user.createdAt.toISOString() },
          { label: 'Login methods', value: data.methods.join(', ') || 'None' },
          { label: 'Ban status', value: data.user.banned ? 'Banned' : 'Active' },
          { label: 'Ban reason', value: data.user.banReason },
          { label: 'Ban expires', value: data.user.banExpires?.toISOString() ?? 'No expiry' },
        ]}
      />
      <h3 className="font-semibold">Workspaces</h3>
      <ul>
        {data.workspaces.map((ws) => (
          <li key={ws.id}>
            <Link to="/admin/workspaces/$id" params={{ id: ws.id }} className="underline">
              {ws.name}
            </Link>{' '}
            · {ws.role}
          </li>
        ))}
      </ul>
      <form
        className="grid max-w-xl gap-3"
        aria-label="Ban management"
        onSubmit={(event) => {
          event.preventDefault()
          void action()
        }}
      >
        <label htmlFor="ban-reason">Reason</label>
        <Input
          disabled={!ready}
          id="ban-reason"
          value={reason}
          maxLength={2000}
          onChange={(event) => setReason(event.target.value)}
          required
        />
        <label>
          <input
            disabled={!ready}
            type="checkbox"
            checked={confirm}
            onChange={(event) => setConfirm(event.target.checked)}
          />{' '}
          I confirm this user status change
        </label>
        <Button
          type="submit"
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
        {data.user.id === admin.id && <p>You cannot ban yourself.</p>}
      </form>
      <Button
        className="w-fit"
        variant="outline"
        disabled={
          !ready ||
          busy ||
          (data.user.role ?? '').split(',').some((role) => role.trim() === 'admin') ||
          Boolean(data.user.banned)
        }
        onClick={() => void action(true)}
      >
        Impersonate user
      </Button>
      <p role="status">{message}</p>
    </section>
  )
}
