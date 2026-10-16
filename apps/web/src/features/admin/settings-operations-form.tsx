import { Button, Input } from '@saas/ui'
import { type FormEvent, useEffect, useState } from 'react'
import { getOperationsSettings, saveOperationsSettings } from './settings-operations.functions.ts'
import { CheckboxField, Field, panelClass } from './ui.tsx'

export function OperationsSettingsForm() {
  const [saved, setSaved] = useState<Awaited<ReturnType<typeof getOperationsSettings>>>()
  const [token, setToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [webhook, setWebhook] = useState('')
  const [clearToken, setClearToken] = useState(false)
  const [clearWebhook, setClearWebhook] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  useEffect(() => {
    void getOperationsSettings()
      .then((value) => {
        setSaved(value)
        setChatId(value.telegramChatId)
      })
      .catch(() => setMessage('Operations settings unavailable.'))
  }, [])
  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await saveOperationsSettings({
        data: {
          telegramChatId: chatId,
          ...(clearToken ? { telegramBotToken: null } : token ? { telegramBotToken: token } : {}),
          ...(clearWebhook
            ? { discordWebhookUrl: null }
            : webhook
              ? { discordWebhookUrl: webhook }
              : {}),
        },
      })
      setToken('')
      setWebhook('')
      setClearToken(false)
      setClearWebhook(false)
      setSaved(await getOperationsSettings())
      setMessage('Operations settings saved.')
    } catch {
      setMessage('Save failed. Check channel configuration and retry.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} aria-label="Operations notifications" className={panelClass()}>
      <h3 className="font-semibold text-lg">Operations notifications</h3>
      <fieldset disabled={!saved || busy} className="grid min-w-0 gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid content-start gap-3">
            <p className="text-sm">
              Telegram bot: {saved?.telegramConfigured ? 'Configured' : 'Not configured'}
            </p>
            <Field label="Telegram bot token" htmlFor="telegram-token">
              <Input
                id="telegram-token"
                type="password"
                autoComplete="new-password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </Field>
            <CheckboxField
              label="Clear Telegram token"
              checked={clearToken}
              onChange={(event) => setClearToken(event.target.checked)}
            />
            <Field label="Telegram chat ID" htmlFor="telegram-chat">
              <Input
                id="telegram-chat"
                value={chatId}
                onChange={(event) => setChatId(event.target.value)}
              />
            </Field>
          </div>
          <div className="grid content-start gap-3">
            <p className="text-sm">
              Discord webhook: {saved?.discordConfigured ? 'Configured' : 'Not configured'}
            </p>
            <Field label="Discord webhook URL" htmlFor="discord-webhook">
              <Input
                id="discord-webhook"
                type="password"
                autoComplete="new-password"
                value={webhook}
                onChange={(event) => setWebhook(event.target.value)}
              />
            </Field>
            <CheckboxField
              label="Clear Discord webhook"
              checked={clearWebhook}
              onChange={(event) => setClearWebhook(event.target.checked)}
            />
          </div>
        </div>
        <p className="text-muted-foreground text-sm">
          Leave secret inputs empty to keep configured values. Notifications retry in the events
          queue.
        </p>
        <Button type="submit" className="w-fit">
          Save operations notifications
        </Button>
      </fieldset>
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </form>
  )
}
