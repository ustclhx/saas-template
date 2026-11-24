import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  cn,
  DropdownContent,
  DropdownMenu,
  DropdownTrigger,
  MenuItem,
} from '@saas/ui'
import { Bot, Ellipsis, Plus, Trash2 } from '@saas/ui/icons'
import { Link, useRouter } from '@tanstack/react-router'
import { useAppShellBarAvailable } from '@web/features/app-shell/bar.tsx'
import { m } from '@web/paraglide/messages.js'
import { getLocale } from '@web/paraglide/runtime.js'
import { useEffect, useState } from 'react'
import { deleteAgentConversation, type listAgentConversations } from './agents.functions.ts'
import { formatActivity, PHASE_TONE, type PhaseTone, turnStateLabel } from './format.ts'
import { createErrorMessage, NewAgentDialog } from './new-dialog.tsx'
import { turnPhase } from './turns.ts'

export type AgentListPageData = Awaited<ReturnType<typeof listAgentConversations>>
type AgentListItem = AgentListPageData['conversations'][number]

const TONE_CLASS: Record<PhaseTone, string> = {
  muted: 'text-muted-foreground',
  warning: 'text-warning',
  destructive: 'text-destructive',
}

/** 桌面表格的列宽：Agent 160px、模型 140px、最近活动 120px、操作 32px，标题占满其余（设计稿 List.dc.html 的 .item） */
const COL = {
  agent: 'shrink-0 md:w-40',
  model: 'shrink-0 md:w-35',
  time: 'shrink-0 md:w-30',
  action: 'shrink-0 md:w-8',
} as const

/** 页头（设计稿 List.dc.html）：标题、说明与「新建对话」；侧边栏布局下顶部条不显示标题，这里是 h1 */
function ListHeader({ onNew, disabled }: { onNew: () => void; disabled: boolean }) {
  const Heading = useAppShellBarAvailable() ? 'h1' : 'h2'
  return (
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <Heading className="font-semibold text-xl">{m.agents_title()}</Heading>
        <p className="text-muted-foreground max-md:hidden">{m.agents_list_description()}</p>
      </div>
      <Button
        type="button"
        leadingIcon={Plus}
        onClick={onNew}
        disabled={disabled}
        className="max-md:hidden"
      >
        {m.agents_new_chat()}
      </Button>
    </div>
  )
}

function useNow() {
  // 首帧按服务端渲染时的时间，水合后每分钟刷新相对时间
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [])
  return now
}

function ConversationRow({
  slug,
  item,
  agentName,
  now,
  first,
  readOnly,
  onDelete,
}: {
  slug: string
  item: AgentListItem
  agentName: string
  now: number
  first: boolean
  readOnly: boolean
  onDelete: (item: AgentListItem) => void
}) {
  const title = item.title || m.agents_untitled()
  const tone = TONE_CLASS[PHASE_TONE[turnPhase(item.turn)]]
  const time = (
    <time
      dateTime={item.updatedAt}
      suppressHydrationWarning
      className="shrink-0 text-muted-foreground max-md:text-caption"
    >
      {formatActivity(item.updatedAt, now, getLocale())}
    </time>
  )
  return (
    <li
      className={cn(
        'relative flex items-center gap-2 px-4 py-3 hover:bg-hover max-md:min-h-16 md:min-h-14 md:gap-4 md:py-2 md:pr-3',
        !first && 'border-t',
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <Link
            to="/app/$slug/agents/$conversationId"
            params={{ slug, conversationId: item.id }}
            className="min-w-0 flex-1 truncate font-medium outline-none after:absolute after:inset-0 focus-visible:underline"
          >
            {title}
          </Link>
          <span className="md:hidden">{time}</span>
        </span>
        <span className={cn('text-caption', tone)}>
          <span className="max-md:hidden">{turnStateLabel(item.turn)}</span>
          <span className="md:hidden">
            {m.agents_list_mobile_state({
              state: turnStateLabel(item.turn, true),
              agent: agentName,
            })}
          </span>
        </span>
      </div>
      <span className={cn(COL.agent, 'max-md:hidden')}>
        <span className="inline-flex h-5 items-center rounded-full bg-chat-fill px-2 font-medium text-caption text-muted-foreground">
          {agentName}
        </span>
      </span>
      <span className={cn(COL.model, 'truncate text-muted-foreground max-md:hidden')}>
        {item.modelKey}
      </span>
      <span className={cn(COL.time, 'max-md:hidden')}>{time}</span>
      <div className={cn(COL.action, 'relative max-md:hidden')}>
        <DropdownMenu>
          <DropdownTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                aria-label={m.agents_row_actions({ title })}
              >
                <Ellipsis aria-hidden />
              </Button>
            }
          />
          <DropdownContent align="end">
            <MenuItem
              index={0}
              icon={Trash2}
              label={m.agents_delete()}
              disabled={readOnly}
              onSelect={() => onDelete(item)}
            />
          </DropdownContent>
        </DropdownMenu>
      </div>
    </li>
  )
}

export function AgentListEmpty({ onNew, disabled }: { onNew: () => void; disabled: boolean }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-xl px-6 py-18 text-center inset-ring inset-ring-border">
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-full bg-chat-fill"
      >
        <Bot className="size-4.5" strokeWidth={1.5} />
      </span>
      <h2 className="mt-1 font-semibold">{m.agents_empty_title()}</h2>
      <p className="max-w-104 text-muted-foreground">{m.agents_empty_description()}</p>
      <Button type="button" className="mt-2" onClick={onNew} disabled={disabled}>
        {m.agents_new_chat()}
      </Button>
    </div>
  )
}

/** 删除确认（不用 confirm()）：删除后对话从列表移除，内容无法恢复 */
function DeleteDialog({
  item,
  pending,
  onConfirm,
  onOpenChange,
}: {
  item: AgentListItem | null
  pending: boolean
  onConfirm: () => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <AlertDialog open={item !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.agents_delete_title()}</AlertDialogTitle>
          <AlertDialogDescription>
            {m.agents_delete_description({ title: item?.title || m.agents_untitled() })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{m.agents_new_cancel()}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            {m.agents_delete()}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * agent 对话列表（openspec add-ai-agents 6.2，设计稿 agents/List.dc.html、ListMobile.dc.html）：
 * 桌面为表格（标题与最近一轮状态、Agent、模型、最近活动、操作），手机为两行列表 + 底部「新建对话」。
 * 加载与失败态分别由路由的 pendingComponent 与 errorComponent 渲染（AgentListSkeleton、AgentListError）。
 */
export function AgentListPage({ slug, page }: { slug: string; page: AgentListPageData }) {
  const router = useRouter()
  const now = useNow()
  const [newOpen, setNewOpen] = useState(false)
  const [deleting, setDeleting] = useState<AgentListItem | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const agentName = (id: string) => page.agents.find((agent) => agent.id === id)?.name ?? id
  const openNew = () => setNewOpen(true)

  async function confirmDelete() {
    if (!deleting) return
    setPending(true)
    setError(null)
    const result = await deleteAgentConversation({
      data: { slug, conversationId: deleting.id },
    })
    setPending(false)
    setDeleting(null)
    if (!result.ok) return setError(createErrorMessage(result.error))
    await router.invalidate()
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-240 flex-col gap-5 max-md:min-h-chat-page">
      <ListHeader onNew={openNew} disabled={page.readOnly} />
      {error ? (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      ) : null}
      {page.conversations.length === 0 ? (
        <AgentListEmpty onNew={openNew} disabled={page.readOnly} />
      ) : (
        <div className="flex flex-col overflow-hidden bg-card max-md:-mx-4 max-md:border-y md:rounded-xl md:inset-ring md:inset-ring-border">
          <div
            aria-hidden
            className={cn(
              'flex min-h-9 items-center gap-4 border-b px-4 pr-3 font-medium text-caption text-muted-foreground max-md:hidden',
            )}
          >
            <span className="flex-1">{m.agents_col_title()}</span>
            <span className={COL.agent}>{m.agents_col_agent()}</span>
            <span className={COL.model}>{m.agents_col_model()}</span>
            <span className={COL.time}>{m.agents_col_activity()}</span>
            <span className={COL.action} />
          </div>
          <ul aria-label={m.agents_list_label()} className="flex flex-col">
            {page.conversations.map((item, index) => (
              <ConversationRow
                key={item.id}
                slug={slug}
                item={item}
                agentName={agentName(item.agentId)}
                now={now}
                first={index === 0}
                readOnly={page.readOnly}
                onDelete={setDeleting}
              />
            ))}
          </ul>
        </div>
      )}
      {page.conversations.length > 0 ? (
        <div className="sticky bottom-0 mt-auto bg-surface-2 pt-3 pb-4 md:hidden">
          <Button type="button" className="h-11 w-full" onClick={openNew} disabled={page.readOnly}>
            {m.agents_new_chat()}
          </Button>
        </div>
      ) : null}
      {newOpen ? (
        <NewAgentDialog
          slug={slug}
          agents={page.agents}
          models={page.models}
          open={newOpen}
          onOpenChange={setNewOpen}
        />
      ) : null}
      <DeleteDialog
        item={deleting}
        pending={pending}
        onConfirm={() => void confirmDelete()}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      />
    </div>
  )
}
