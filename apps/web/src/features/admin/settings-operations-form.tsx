import { Button, Input, Label } from '@saas/ui'
import { type FormEvent, useEffect, useState } from 'react'
import { getOperationsSettings, saveOperationsSettings } from './settings-operations.functions.ts'

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
    <form onSubmit={submit} aria-label="Operations notifications" className="grid gap-3">
      <h3 className="font-semibold">Operations notifications</h3>
      <fieldset disabled={!saved || busy} className="grid gap-3">
        <p>Telegram bot: {saved?.telegramConfigured ? 'Configured' : 'Not configured'}</p>
        <Label htmlFor="telegram-token">Telegram bot token</Label>
        <Input
          id="telegram-token"
          type="password"
          autoComplete="new-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        <Label>
          <input
            type="checkbox"
            checked={clearToken}
            onChange={(event) => setClearToken(event.target.checked)}
          />{' '}
          Clear Telegram token
        </Label>
        <Label htmlFor="telegram-chat">Telegram chat ID</Label>
        <Input
          id="telegram-chat"
          value={chatId}
          onChange={(event) => setChatId(event.target.value)}
        />
        <p>Discord webhook: {saved?.discordConfigured ? 'Configured' : 'Not configured'}</p>
        <Label htmlFor="discord-webhook">Discord webhook URL</Label>
        <Input
          id="discord-webhook"
          type="password"
          autoComplete="new-password"
          value={webhook}
          onChange={(event) => setWebhook(event.target.value)}
        />
        <Label>
          <input
            type="checkbox"
            checked={clearWebhook}
            onChange={(event) => setClearWebhook(event.target.checked)}
          />{' '}
          Clear Discord webhook
        </Label>
        <p>
          Leave secret inputs empty to keep configured values. Notifications retry in the events
          queue.
        </p>
        <Button type="submit">Save operations notifications</Button>
      </fieldset>
      <p role="status">{message}</p>
    </form>
  )
}
