import { Button } from '@saas/ui'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { type FormEvent, useEffect, useState } from 'react'
import { getAdminSettings, saveAdminSettings } from '../../features/admin/settings.functions.ts'
import { OperationsSettingsForm } from '../../features/admin/settings-operations-form.tsx'
import { AdminPage, CheckboxField, Field, panelClass, Textarea } from '../../features/admin/ui.tsx'

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
    <AdminPage title="Runtime settings" className="max-w-3xl">
      <form onSubmit={submit} aria-label="Runtime settings" className={panelClass()}>
        <fieldset disabled={!hydrated || busy} className="grid min-w-0 gap-5">
          <div className="grid gap-2">
            <CheckboxField
              label="Registration enabled"
              checked={signupEnabled}
              onChange={(event) => setSignupEnabled(event.target.checked)}
            />
            <p className="text-muted-foreground text-sm">
              When registration is closed, only valid waitlist invitations can admit new users if
              waitlist is enabled.
            </p>
          </div>
          <Field
            label="Site announcement"
            htmlFor="announcement"
            description="Plain text shown across the site. Leave empty to hide the banner."
          >
            <Textarea
              id="announcement"
              rows={4}
              maxLength={2000}
              value={announcement}
              onChange={(event) => setAnnouncement(event.target.value)}
            />
          </Field>
          <Field
            label="Disposable email domains"
            htmlFor="blacklist"
            description="One domain per line, or comma separated. These domains and their subdomains cannot receive signup bonus credits; registration itself is unaffected."
          >
            <Textarea
              id="blacklist"
              rows={8}
              value={blacklist}
              onChange={(event) => setBlacklist(event.target.value)}
            />
          </Field>
          <Button type="submit" className="w-fit">
            Save settings
          </Button>
        </fieldset>
      </form>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <OperationsSettingsForm />
    </AdminPage>
  )
}
