import { Button, Label } from '@saas/ui'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { type FormEvent, useEffect, useState } from 'react'
import { getAdminSettings, saveAdminSettings } from '../../features/admin/settings.functions.ts'
import { OperationsSettingsForm } from '../../features/admin/settings-operations-form.tsx'

export const Route = createFileRoute('/admin/settings')({
  loader: () => getAdminSettings(),
  errorComponent: () => <p role="alert">Settings are unavailable. Please reload.</p>,
  component: Settings,
})

function Settings() {
  const saved = Route.useLoaderData()
  const router = useRouter()
  const [signupEnabled, setSignupEnabled] = useState(saved.signupEnabled)
  const [announcement, setAnnouncement] = useState(saved.announcement)
  const [blacklist, setBlacklist] = useState(saved.signupBonusDomainBlacklist.join('\n'))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      const result = await saveAdminSettings({
        data: {
          signupEnabled,
          announcement,
          signupBonusDomainBlacklist: blacklist
            .split(/[\n,]/)
            .map((entry) => entry.trim())
            .filter(Boolean),
        },
      })
      setMessage(
        result.ok
          ? 'Saved. Changes apply within about 60 seconds.'
          : (result.error ?? 'Save failed.'),
      )
      await router.invalidate()
    } catch {
      setMessage('Save unavailable. Enter valid domains (no email addresses or URLs) and retry.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="grid max-w-2xl gap-5">
      <h2 className="font-semibold text-xl">Runtime settings</h2>
      <form onSubmit={submit} aria-label="Runtime settings">
        <fieldset disabled={!hydrated || busy} className="grid gap-5">
          <Label>
            <input
              type="checkbox"
              checked={signupEnabled}
              onChange={(event) => setSignupEnabled(event.target.checked)}
            />{' '}
            Registration enabled
          </Label>
          <p>
            When registration is closed, only valid waitlist invitations can admit new users if
            waitlist is enabled.
          </p>
          <Label htmlFor="announcement">Site announcement</Label>
          <textarea
            id="announcement"
            className="rounded-md border p-3"
            rows={4}
            maxLength={2000}
            value={announcement}
            onChange={(event) => setAnnouncement(event.target.value)}
          />
          <p>Plain text shown across the site. Leave empty to hide the banner.</p>
          <Label htmlFor="blacklist">Disposable email domains</Label>
          <textarea
            id="blacklist"
            className="rounded-md border p-3"
            rows={8}
            value={blacklist}
            onChange={(event) => setBlacklist(event.target.value)}
          />
          <p>
            One domain per line, or comma separated. These domains and their subdomains cannot
            receive signup bonus credits; registration itself is unaffected.
          </p>
          <Button type="submit">Save settings</Button>
        </fieldset>
      </form>
      <p role="status">{message}</p>
      <OperationsSettingsForm />
    </section>
  )
}
