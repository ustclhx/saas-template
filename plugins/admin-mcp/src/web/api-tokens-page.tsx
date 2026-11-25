import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Checkbox,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@saas/ui'
import { CircleAlert, Copy, KeyRound, Plus } from '@saas/ui/icons'
import { useRouter } from '@tanstack/react-router'
import { isStepUpCancelled } from '@web/features/admin/step-up/client.ts'
import { useStepUpCall } from '@web/features/admin/step-up/step-up-provider.tsx'
import { AdminPage } from '@web/features/admin/ui.tsx'
import { m } from '@web/paraglide/messages.js'
import { getLocale } from '@web/paraglide/runtime.js'
import { templateConfig } from '@web/server/template-config.ts'
import { type ReactNode, useEffect, useId, useState, useSyncExternalStore } from 'react'
import { createAdminApiTokenFn, revokeAdminApiTokenFn } from './api-tokens.functions.ts'
import {
  claudeCommand,
  defaultTerm,
  expiryDate,
  formatDate,
  maskToken,
  mcpServerName,
  relativeTime,
  sortTokens,
  TOKEN_NAME_MAX,
  type TokenRow,
  tokenState,
} from './api-tokens.ts'

// 后台 API 令牌页（设计稿 admin-mcp/Main.dc.html、TokensMobile.dc.html）。
// 桌面为表格与居中弹窗，手机为卡片列表与底部面板；吊销用确认对话框。

export interface ApiTokensData {
  readonly tokens: readonly TokenRow[]
  readonly endpoint: string
  readonly terms: readonly number[]
  readonly now: Date
}

// 与 Tailwind md 断点一致；服务端与水合首帧按桌面渲染（弹窗只在交互后打开）
const DESKTOP_QUERY = '(min-width: 48rem)'
function subscribeDesktop(onChange: () => void) {
  const query = window.matchMedia(DESKTOP_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
function useDesktop() {
  return useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  )
}

/** 复制到剪贴板，按键显示「已复制」两秒；失败时提示手动复制 */
function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(null), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setFailed(false)
      setCopied(key)
    } catch {
      setFailed(true)
    }
  }
  return { copied, failed, copy }
}

type Created = Awaited<ReturnType<typeof createAdminApiTokenFn>> & { days: number }

export function ApiTokensPage({ data }: { data: ApiTokensData }) {
  const router = useRouter()
  const [ready, setReady] = useState(false)
  useEffect(() => setReady(true), [])
  const [createOpen, setCreateOpen] = useState(false)
  const [created, setCreated] = useState<Created | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<TokenRow | null>(null)
  const { copied, failed, copy } = useCopy()
  const tokens = sortTokens(data.tokens, data.now)

  const createButton = (
    <Button type="button" disabled={!ready} leadingIcon={Plus} onClick={() => setCreateOpen(true)}>
      {m.admin_mcp_create()}
    </Button>
  )

  return (
    <AdminPage
      title={m.admin_mcp_title()}
      description={
        <>
          <span className="hidden md:inline">{m.admin_mcp_description()}</span>
          <span className="md:hidden">{m.admin_mcp_description_short()}</span>
        </>
      }
      actions={createButton}
      className="max-w-5xl"
    >
      <EndpointCard
        endpoint={data.endpoint}
        copied={copied === 'endpoint'}
        disabled={!ready}
        onCopy={() => void copy('endpoint', data.endpoint)}
      />
      {failed ? (
        <p role="alert" className="text-destructive text-sm">
          {m.admin_mcp_copy_failed()}
        </p>
      ) : null}
      {tokens.length === 0 ? (
        <EmptyTokens action={createButton} />
      ) : (
        <>
          <TokenTable tokens={tokens} now={data.now} disabled={!ready} onRevoke={setRevokeTarget} />
          <TokenCards tokens={tokens} now={data.now} disabled={!ready} onRevoke={setRevokeTarget} />
          <p className="text-muted-foreground text-xs">{m.admin_mcp_footnote()}</p>
        </>
      )}
      <CreateTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        terms={data.terms}
        now={data.now}
        onCreated={(result) => {
          setCreateOpen(false)
          setCreated(result)
          void router.invalidate()
        }}
      />
      <CreatedTokenDialog
        created={created}
        endpoint={data.endpoint}
        copied={copied}
        onCopy={copy}
        onClose={() => setCreated(null)}
      />
      <RevokeTokenDialog
        token={revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onRevoked={async () => {
          await router.invalidate()
          setRevokeTarget(null)
        }}
      />
    </AdminPage>
  )
}

function EndpointCard({
  endpoint,
  copied,
  disabled,
  onCopy,
}: {
  endpoint: string
  copied: boolean
  disabled: boolean
  onCopy: () => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-4 rounded-xl bg-card p-3 inset-ring inset-ring-border md:p-4">
      <div className="grid min-w-0 flex-1 gap-1">
        <span className="font-medium text-muted-foreground text-xs">{m.admin_mcp_endpoint()}</span>
        <span className="truncate font-mono text-sm">{endpoint}</span>
        <span className="hidden text-muted-foreground text-xs md:block">
          {m.admin_mcp_endpoint_hint()}
        </span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        leadingIcon={Copy}
        onClick={onCopy}
        className="hidden md:inline-flex"
      >
        {copied ? m.admin_mcp_copied() : m.admin_mcp_copy_endpoint()}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        disabled={disabled}
        aria-label={copied ? m.admin_mcp_copied() : m.admin_mcp_copy_endpoint_label()}
        onClick={onCopy}
        className="text-muted-foreground md:hidden"
      >
        <Copy />
      </Button>
    </div>
  )
}

function ScopeBadges({ scopes }: { scopes: readonly string[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Badge color="gray" size="compact">
        {m.admin_mcp_scope_read()}
      </Badge>
      {scopes.includes('admin:write') ? (
        <Badge color="amber" size="compact">
          {m.admin_mcp_scope_write()}
        </Badge>
      ) : null}
    </span>
  )
}

function lastUsed(token: TokenRow, now: Date) {
  return token.lastUsedAt
    ? relativeTime(token.lastUsedAt, now, getLocale())
    : m.admin_mcp_never_used()
}

interface ListProps {
  tokens: readonly TokenRow[]
  now: Date
  disabled: boolean
  onRevoke: (token: TokenRow) => void
}

function TokenTable({ tokens, now, disabled, onRevoke }: ListProps) {
  return (
    <div className="hidden overflow-hidden rounded-xl bg-card inset-ring inset-ring-border md:block">
      <table className="w-full text-sm" aria-label={m.admin_mcp_list_label()}>
        <thead className="text-left text-muted-foreground text-xs">
          <tr className="border-b">
            <th className="py-2.5 pr-4 pl-4 font-medium">{m.admin_mcp_col_name()}</th>
            <th className="w-36 py-2.5 pr-4 font-medium">{m.admin_mcp_col_prefix()}</th>
            <th className="w-36 py-2.5 pr-4 font-medium">{m.admin_mcp_col_scopes()}</th>
            <th className="w-40 py-2.5 pr-4 font-medium">{m.admin_mcp_col_expires()}</th>
            <th className="w-32 py-2.5 pr-4 font-medium">{m.admin_mcp_col_last_used()}</th>
            <th className="w-20 py-2.5 pr-3">
              <span className="sr-only">{m.admin_mcp_col_actions()}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((token) => {
            const state = tokenState(token, now)
            const active = state.kind === 'active'
            return (
              <tr
                key={token.id}
                className={cn('border-t first:border-t-0', !active && 'text-muted-foreground')}
              >
                <td className="max-w-0 py-2 pr-4 pl-4">
                  <span className="block truncate font-medium">{token.name}</span>
                  <span className="block text-muted-foreground text-xs">
                    {state.kind === 'active'
                      ? m.admin_mcp_state_active()
                      : state.kind === 'revoked'
                        ? m.admin_mcp_state_revoked({ date: formatDate(state.at) })
                        : m.admin_mcp_state_expired()}
                  </span>
                </td>
                <td className="py-2 pr-4 font-mono text-muted-foreground">{`${token.prefix}…`}</td>
                <td className="py-2 pr-4">
                  <ScopeBadges scopes={token.scopes} />
                </td>
                <td className="py-2 pr-4">
                  <span className="block">{formatDate(token.expiresAt)}</span>
                  {state.kind === 'active' ? (
                    <span
                      className={cn(
                        'block text-xs',
                        state.expiring ? 'text-warning' : 'text-muted-foreground',
                      )}
                    >
                      {state.expiring
                        ? m.admin_mcp_days_left_warning({ days: state.daysLeft })
                        : m.admin_mcp_days_left({ days: state.daysLeft })}
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-4 text-muted-foreground">{lastUsed(token, now)}</td>
                <td className="py-2 pr-3 text-right">
                  {active ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={disabled}
                      aria-label={m.admin_mcp_revoke_label({ name: token.name })}
                      onClick={() => onRevoke(token)}
                      className="text-destructive"
                    >
                      {m.admin_mcp_revoke()}
                    </Button>
                  ) : null}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function TokenCards({ tokens, now, disabled, onRevoke }: ListProps) {
  return (
    <ul className="grid gap-3 md:hidden" aria-label={m.admin_mcp_list_label()}>
      {tokens.map((token) => {
        const state = tokenState(token, now)
        const active = state.kind === 'active'
        const meta =
          state.kind === 'active'
            ? m.admin_mcp_mobile_meta_active({
                expires: state.expiring
                  ? m.admin_mcp_days_left_warning({ days: state.daysLeft })
                  : m.admin_mcp_expires_on({ date: formatDate(token.expiresAt) }),
                used: token.lastUsedAt
                  ? m.admin_mcp_mobile_meta_used({ when: lastUsed(token, now) })
                  : m.admin_mcp_never_used(),
              })
            : state.kind === 'revoked'
              ? m.admin_mcp_mobile_meta_revoked({ date: formatDate(state.at) })
              : m.admin_mcp_mobile_meta_expired({ date: formatDate(token.expiresAt) })
        return (
          <li
            key={token.id}
            className={cn(
              'grid gap-2 rounded-lg bg-card p-3 inset-ring inset-ring-border',
              !active && 'text-muted-foreground',
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{token.name}</span>
              {active ? (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={disabled}
                  aria-label={m.admin_mcp_revoke_label({ name: token.name })}
                  onClick={() => onRevoke(token)}
                  className="px-2.5 text-destructive"
                >
                  {m.admin_mcp_revoke()}
                </Button>
              ) : (
                <span className="text-xs">
                  {state.kind === 'revoked'
                    ? m.admin_mcp_state_revoked_short()
                    : m.admin_mcp_state_expired()}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-muted-foreground text-xs">{`${token.prefix}…`}</span>
              <ScopeBadges scopes={token.scopes} />
            </div>
            <span
              className={cn(
                'text-xs',
                state.kind === 'active' && state.expiring
                  ? 'text-warning'
                  : 'text-muted-foreground',
              )}
            >
              {meta}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function EmptyTokens({ action }: { action: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-xl px-6 py-16 text-center inset-ring inset-ring-border">
      <span
        aria-hidden="true"
        className="flex size-10 items-center justify-center rounded-full bg-secondary"
      >
        <KeyRound className="size-4.5" />
      </span>
      <h3 className="mt-1 font-semibold text-sm">{m.admin_mcp_empty_title()}</h3>
      <p className="max-w-md text-muted-foreground text-sm">{m.admin_mcp_empty_body()}</p>
      <div className="mt-2">{action}</div>
    </div>
  )
}

/** 桌面居中弹窗、手机底部面板的统一外壳 */
function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  size,
  children,
  footer,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  size: 'lg' | 'xl'
  children: ReactNode
  footer: ReactNode
}) {
  const desktop = useDesktop()
  if (desktop)
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size={size} showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 flex-col gap-4">{children}</div>
          <DialogFooter>{footer}</DialogFooter>
        </DialogContent>
      </Dialog>
    )
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" showCloseButton={false}>
        <div className="flex min-w-0 flex-col gap-3.5 px-4 pt-2 pb-6">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription className="text-caption">{description}</SheetDescription>
          {children}
          <div className="flex flex-col-reverse gap-2">{footer}</div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function CreateTokenDialog({
  open,
  onOpenChange,
  terms,
  now,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  terms: readonly number[]
  now: Date
  onCreated: (created: Created) => void
}) {
  const id = useId()
  const [name, setName] = useState('')
  const [write, setWrite] = useState(true)
  const [days, setDays] = useState(() => defaultTerm(terms))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 创建令牌为敏感操作（产生长期管理员凭据）：未重新验证时当场弹窗
  const createToken = useStepUpCall(createAdminApiTokenFn, { action: m.admin_mcp_create_title() })

  // 每次打开都从默认值开始，避免沿用上一次的输入
  useEffect(() => {
    if (!open) return
    setName('')
    setWrite(true)
    setDays(defaultTerm(terms))
    setError(null)
  }, [open, terms])

  async function submit() {
    if (!name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const result = await createToken({ data: { name: name.trim(), write, days } })
      // 取消验证：令牌未创建，对话框与已填写的名称、权限保留
      if (isStepUpCancelled(result)) return
      onCreated({ ...result, days })
    } catch {
      setError(m.admin_mcp_create_failed())
    } finally {
      setBusy(false)
    }
  }

  const max = Math.max(...terms)
  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next)
      }}
      title={m.admin_mcp_create_title()}
      description={m.admin_mcp_create_description()}
      size="lg"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {m.admin_mcp_cancel()}
          </Button>
          <Button
            type="button"
            loading={busy}
            disabled={!name.trim()}
            onClick={() => void submit()}
          >
            {m.admin_mcp_submit()}
          </Button>
        </>
      }
    >
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-name`}>{m.admin_mcp_name()}</Label>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={TOKEN_NAME_MAX}
          placeholder={m.admin_mcp_name_placeholder()}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
        />
      </div>
      <fieldset className="grid gap-2.5">
        <legend className="mb-2 font-medium text-sm">{m.admin_mcp_scopes()}</legend>
        <Label htmlFor={`${id}-read`} className="items-start font-normal">
          <Checkbox id={`${id}-read`} checked disabled className="mt-0.5" />
          <span className="grid gap-0.5">
            <span className="font-medium">{m.admin_mcp_scope_read_title()}</span>
            <span className="text-muted-foreground text-xs">
              {m.admin_mcp_scope_read_description()}
            </span>
          </span>
        </Label>
        <Label htmlFor={`${id}-write`} className="items-start font-normal">
          <Checkbox
            id={`${id}-write`}
            checked={write}
            onCheckedChange={setWrite}
            className="mt-0.5"
          />
          <span className="grid gap-0.5">
            <span className="font-medium">{m.admin_mcp_scope_write()}</span>
            <span className="text-muted-foreground text-xs">
              {m.admin_mcp_scope_write_description()}
            </span>
          </span>
        </Label>
      </fieldset>
      <fieldset className="grid min-w-0 gap-1.5">
        <legend className="mb-1.5 font-medium text-sm">{m.admin_mcp_term()}</legend>
        <div className="flex gap-1 rounded-lg bg-secondary p-0.5">
          {terms.map((term) => (
            <button
              key={term}
              type="button"
              aria-pressed={term === days}
              onClick={() => setDays(term)}
              className={cn(
                'h-8 flex-1 whitespace-nowrap rounded-md px-1.5 font-medium sm:px-3 text-sm outline-none transition-colors',
                'focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:outline-offset-2',
                term === days
                  ? 'bg-card shadow-surface-2'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {m.admin_mcp_term_days({ days: term })}
            </button>
          ))}
        </div>
        <span className="text-muted-foreground text-xs">
          {m.admin_mcp_term_hint({ date: expiryDate(days, now), max })}
        </span>
      </fieldset>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </ResponsiveDialog>
  )
}

function CreatedTokenDialog({
  created,
  endpoint,
  copied,
  onCopy,
  onClose,
}: {
  created: Created | null
  endpoint: string
  copied: string | null
  onCopy: (key: string, text: string) => Promise<void>
  onClose: () => void
}) {
  const desktop = useDesktop()
  // 关闭动画期间保留内容
  const [shown, setShown] = useState(created)
  useEffect(() => {
    if (created) setShown(created)
  }, [created])
  if (!shown) return null

  const { token, metadata, days } = shown
  const server = mcpServerName(templateConfig.app.name)
  const command = claudeCommand(server, endpoint, token)
  const summary = (
    metadata.scopes.includes('admin:write')
      ? m.admin_mcp_created_summary_rw
      : m.admin_mcp_created_summary_r
  )({ name: metadata.name, days })

  return (
    <ResponsiveDialog
      open={created !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
      title={m.admin_mcp_created_title()}
      description={summary}
      size="xl"
      footer={
        <Button type="button" variant={desktop ? 'outline' : 'ghost'} onClick={onClose}>
          {m.admin_mcp_saved_close()}
        </Button>
      }
    >
      <div
        role="status"
        className="flex gap-2.5 rounded-lg bg-warning/10 px-3 py-2.5 text-sm text-warning"
      >
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{desktop ? m.admin_mcp_created_warning() : m.admin_mcp_created_warning_short()}</span>
      </div>
      <div className="grid gap-1.5">
        <span className="font-medium text-sm">{m.admin_mcp_token()}</span>
        <div className="flex min-w-0 flex-col gap-2 md:flex-row">
          <code className="min-w-0 flex-1 break-all rounded-lg bg-secondary px-3 py-2 font-mono text-sm">
            {token}
          </code>
          <Button type="button" onClick={() => void onCopy('token', token)}>
            {copied === 'token' ? m.admin_mcp_copied() : m.admin_mcp_copy_token()}
          </Button>
        </div>
      </div>
      <div className="grid gap-1.5">
        <span className="hidden font-medium text-sm md:block">{m.admin_mcp_command()}</span>
        <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-start">
          <code className="hidden min-w-0 flex-1 whitespace-pre-wrap break-all rounded-lg bg-secondary px-3 py-2.5 font-mono text-sm md:block">
            {claudeCommand(server, endpoint, maskToken(token))}
          </code>
          <Button type="button" variant="outline" onClick={() => void onCopy('command', command)}>
            {copied === 'command'
              ? m.admin_mcp_copied()
              : desktop
                ? m.admin_mcp_copy_command()
                : m.admin_mcp_copy_command_mobile()}
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  )
}

function RevokeTokenDialog({
  token,
  onClose,
  onRevoked,
}: {
  token: TokenRow | null
  onClose: () => void
  onRevoked: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(token)
  useEffect(() => {
    if (token) {
      setShown(token)
      setError(null)
    }
  }, [token])

  async function confirm() {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      await revokeAdminApiTokenFn({ data: { id: token.id } })
      await onRevoked()
    } catch {
      setError(m.admin_mcp_revoke_failed())
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog
      open={token !== null}
      onOpenChange={(open) => {
        // 请求进行中忽略 Escape，避免关闭后结果无处展示
        if (!open && !busy) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {m.admin_mcp_revoke_title({ name: shown?.name ?? '' })}
          </AlertDialogTitle>
          <AlertDialogDescription>{m.admin_mcp_revoke_body()}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{m.admin_mcp_cancel()}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            loading={busy}
            onClick={(event) => {
              // 阻止立即关闭，等请求完成后再关闭
              event.preventDefault()
              void confirm()
            }}
          >
            {m.admin_mcp_revoke_confirm()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
