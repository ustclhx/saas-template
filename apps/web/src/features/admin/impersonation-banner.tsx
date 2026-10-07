import { useEffect, useState } from 'react'
import { stopAdminImpersonation } from './impersonation.functions.ts'

export function ImpersonationBanner({
  viewer,
}: {
  viewer: { userEmail: string; adminEmail: string } | null
}) {
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!viewer) return null
  async function stop() {
    setBusy(true)
    try {
      await stopAdminImpersonation()
      window.location.assign('/admin/users?offset=0')
    } catch {
      setError('Unable to stop impersonating. Please retry.')
      setBusy(false)
    }
  }
  return (
    <aside
      role="status"
      aria-label="Impersonation"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-3 border-b bg-amber-100 p-3 text-amber-950"
    >
      <span>
        Impersonating {viewer.userEmail} · Administrator: {viewer.adminEmail}. Sensitive actions are
        disabled.
      </span>
      <button
        type="button"
        disabled={!ready || busy}
        className="font-semibold underline"
        onClick={() => void stop()}
      >
        Stop impersonating
      </button>
      {error && <span role="alert">{error}</span>}
    </aside>
  )
}
