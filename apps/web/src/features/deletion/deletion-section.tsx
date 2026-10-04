import { useState } from 'react'
import { removeAccount, removeWorkspace } from './deletion.functions.ts'

export function DeletionSection({ workspace }: { workspace?: { id: string; name: string } }) {
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [blocked, setBlocked] = useState<{ id: string; name: string; slug: string }[]>([])
  const label = workspace ? workspace.name : 'DELETE'
  async function submit() {
    setBusy(true)
    setError('')
    try {
      const result = workspace
        ? await removeWorkspace({ data: { workspaceId: workspace.id } })
        : await removeAccount()
      if (result.ok) {
        window.location.assign(workspace ? '/app' : '/login')
        return
      }
      setError(result.message)
      setBlocked(result.workspaces)
    } catch {
      setError('Deletion could not be completed. Please try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="grid gap-3 rounded-lg border border-destructive p-6">
      <h2 className="font-semibold text-xl">
        {workspace ? 'Delete team workspace' : 'Delete account'}
      </h2>
      <p>
        {workspace
          ? 'All members will lose access immediately. Workspace content is retained for 30 days before cleanup.'
          : 'Your personal workspace will be deleted and your identity and sign-in credentials removed. Sign out and sign in again within ten minutes before deleting.'}
      </p>
      <p>
        Deletion does not issue a refund by default. Refund requests are not available in this
        release; contact the service support team before deleting if you need help with a payment.
      </p>
      {!workspace && (
        <a className="underline" href="/login?redirect=%2Faccount">
          Sign in again
        </a>
      )}
      <label className="grid gap-2">
        Type {label} to confirm
        <input
          className="rounded border p-2"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
        />
      </label>
      {error && <p role="alert">{error}</p>}
      {blocked.length > 0 && (
        <ul>
          {blocked.map((item) => (
            <li key={item.id}>
              <a className="underline" href={`/app/${item.slug}`}>
                {item.name}
              </a>
              : transfer ownership or delete this team first.
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="rounded bg-destructive p-2 text-destructive-foreground disabled:opacity-50"
        disabled={busy || confirmation !== label}
        onClick={() => void submit()}
      >
        {busy ? 'Deleting…' : workspace ? 'Delete workspace' : 'Delete account'}
      </button>
    </section>
  )
}
