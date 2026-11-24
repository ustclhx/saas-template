import { useAgentChat } from '@cloudflare/ai-chat/react'
import { estimateInputTokens } from '@saas/ai/client'
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
import { InputMessage } from '@saas/ui/chat'
import { Bot, ChevronLeft, CircleAlert, Ellipsis, Trash2 } from '@saas/ui/icons'
import { Link, useNavigate } from '@tanstack/react-router'
import { ChatErrorAlert } from '@web/features/ai/chat-composer.tsx'
import { formatNumber, SuggestionChips } from '@web/features/ai/chat-extras.tsx'
import { CopyReplyButton } from '@web/features/ai/chat-thread.tsx'
import { type ChatUIMessage, messageText, titleFromText } from '@web/features/ai/conversation.ts'
import { ChatMessageView } from '@web/features/ai/message-parts.tsx'
import { creditEstimate, type PickerModel } from '@web/features/ai/model-picker.ts'
import { ModelPicker } from '@web/features/ai/model-picker.tsx'
import { useAppShellBarAvailable } from '@web/features/app-shell/bar.tsx'
import { m } from '@web/paraglide/messages.js'
import { useAgent } from 'agents/react'
import { isToolUIPart } from 'ai'
import {
  Component,
  type ErrorInfo,
  type ReactNode,
  type RefObject,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import {
  deleteAgentConversation,
  type getAgentConversation,
  getAgentTurns,
  renameAgentConversation,
  setAgentConversationModel,
} from './agents.functions.ts'
import type { AgentOption } from './catalog.ts'
import { turnSummary } from './format.ts'
import { createErrorMessage } from './new-dialog.tsx'
import { agentToolPartRenderer } from './tool-cards.tsx'
import type { AgentTurnView } from './turns.ts'

export type AgentChatPageData = Awaited<ReturnType<typeof getAgentConversation>>

/** web Worker 中 `AGENT_CONVERSATION` 绑定的路由名：`/agents/agent-conversation/<conversationId>`（1.1 验证结果） */
export const AGENT_ROUTE_NAME = 'agent-conversation'
/** 流式更新的节流间隔，与文本对话一致 */
const THROTTLE_MS = 50
/** 距离底部小于该值视为「在底部」，新内容到达时跟随滚动 */
const FOLLOW_THRESHOLD_PX = 96

// ---------------------------------------------------------------------------
// 纯函数（组件测试直接覆盖）
// ---------------------------------------------------------------------------

/** 每轮预留的积分上限（展示用）：单步预计上限 × 最多步数，按 maxTurnCredits 封顶；实际预扣以服务端为准 */
export function turnReserve(
  model: PickerModel | undefined,
  options: { inputTokens: number; maxSteps: number; maxTurnCredits: number | null },
): number | null {
  if (!model) return null
  const estimate = creditEstimate(model.pricing, { inputTokens: options.inputTokens })
  const perStep = estimate.kind === 'range' ? estimate.max : estimate.credits
  const total = perStep * options.maxSteps
  return options.maxTurnCredits === null ? total : Math.min(total, options.maxTurnCredits)
}

/** 回复对应的轮次：消息元数据带 `turnId` 时按 id 匹配；否则只有最后一条回复对应最近一轮 */
export function turnForMessage(
  message: ChatUIMessage,
  isLastReply: boolean,
  turns: readonly AgentTurnView[],
): AgentTurnView | undefined {
  const turnId = (message.metadata as { turnId?: unknown } | undefined)?.turnId
  if (typeof turnId === 'string') return turns.find((turn) => turn.id === turnId)
  return isLastReply ? turns.at(-1) : undefined
}

/** 回复中是否有等待确认的工具调用 */
export const awaitingApproval = (message: ChatUIMessage | undefined) =>
  message?.role === 'assistant' &&
  message.parts.some((part) => isToolUIPart(part) && part.state === 'approval-requested')

/** 实例消息端点（`…/get-messages`）读取历史；失败时抛出，由页面显示错误态，而不是空对话 */
async function fetchInitialMessages({ url }: { url?: string | undefined }) {
  if (!url) return []
  const target = new URL(url)
  target.pathname += '/get-messages'
  const response = await fetch(target, { credentials: 'same-origin' })
  if (!response.ok) throw new Error(`get-messages ${response.status}`)
  const text = await response.text()
  return text.trim() ? (JSON.parse(text) as ChatUIMessage[]) : []
}

// ---------------------------------------------------------------------------
// 页头
// ---------------------------------------------------------------------------

function DeleteConversation({ slug, conversationId }: { slug: string; conversationId: string }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function confirm() {
    setPending(true)
    setError(null)
    const result = await deleteAgentConversation({ data: { slug, conversationId } })
    setPending(false)
    if (!result.ok) return setError(createErrorMessage(result.error))
    setOpen(false)
    await navigate({ to: '/app/$slug/agents', params: { slug } })
  }
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <DropdownMenu>
        <DropdownTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground"
              aria-label={m.agents_actions()}
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
            onSelect={() => setOpen(true)}
          />
        </DropdownContent>
      </DropdownMenu>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{m.agents_delete_title()}</AlertDialogTitle>
          <AlertDialogDescription>{m.agents_delete_description_current()}</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-caption text-destructive">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{m.agents_new_cancel()}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault()
              void confirm()
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
 * 页头（设计稿 Main.dc.html 的 .top；Mobile.dc.html 为返回图标 + 标题与「agent · 模型」两行）：
 * 侧边栏布局下顶部条不显示标题（路由 staticData.shellTitle = false），对话标题是页面 h1。
 */
function AgentChatHeader({
  slug,
  conversationId,
  title,
  agent,
  modelKey,
  readOnly,
}: {
  slug: string
  conversationId: string
  title: string
  agent: AgentOption
  modelKey: string
  readOnly: boolean
}) {
  const Heading = useAppShellBarAvailable() ? 'h1' : 'h2'
  return (
    <div className="flex min-h-12 min-w-0 items-center gap-2 border-b pb-2">
      <Link
        to="/app/$slug/agents"
        params={{ slug }}
        aria-label={m.agents_all_chats()}
        className="flex h-7 shrink-0 items-center gap-1 rounded-lg pr-2 pl-1 text-body text-muted-foreground outline-none hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--focus-ring) max-sm:size-11 max-sm:justify-center max-sm:p-0"
      >
        <ChevronLeft aria-hidden className="size-4" strokeWidth={1.5} />
        <span className="max-sm:hidden">{m.agents_all_chats()}</span>
      </Link>
      <span aria-hidden className="h-4 w-px shrink-0 bg-border max-sm:hidden" />
      <div className="flex min-w-0 flex-1 items-center gap-2 max-sm:flex-col max-sm:items-start max-sm:gap-0 sm:ml-1">
        <Heading className="min-w-0 max-w-full truncate font-semibold text-subtitle">
          {title || m.agents_untitled()}
        </Heading>
        <span className="inline-flex h-4.5 shrink-0 items-center rounded-full bg-chat-fill px-1.5 font-medium text-caption text-muted-foreground max-sm:hidden">
          {agent.name}
        </span>
        <span className="text-caption text-muted-foreground sm:hidden">
          {m.agents_header_mobile_meta({ agent: agent.name, model: modelKey })}
        </span>
      </div>
      {readOnly ? null : <DeleteConversation slug={slug} conversationId={conversationId} />}
    </div>
  )
}

/** 助手头像：agent 图标（设计稿 Main.dc.html 的 .av），尺寸随 ChatMessage 的版式切换 */
const AGENT_AVATAR = (
  <span
    aria-hidden
    data-chat-avatar=""
    className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground @chat-message:size-7"
  >
    <Bot className="size-3.5" strokeWidth={1.75} />
  </span>
)

// ---------------------------------------------------------------------------
// 消息区的空、加载、错误态
// ---------------------------------------------------------------------------

/** 空对话（设计稿 Main.dc.html 的 empty）：agent 介绍、工具与示例任务 */
function AgentEmptyState({
  agent,
  disabled,
  onSelect,
}: {
  agent: AgentOption
  disabled: boolean
  onSelect: (text: string) => void
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 pt-16 text-center md:pt-28">
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground"
      >
        <Bot className="size-4.5" strokeWidth={1.75} />
      </span>
      <h2 className="mt-1.5 font-semibold text-title">{agent.name}</h2>
      <p className="max-w-112 text-muted-foreground">{agent.description}</p>
      {agent.tools.length ? (
        <ul
          aria-label={m.agents_tools_label()}
          className="mt-1 flex flex-wrap justify-center gap-1.5"
        >
          {agent.tools.map((tool) => (
            <li
              key={tool}
              className="inline-flex h-4.5 items-center rounded-full bg-chat-fill px-1.5 font-mono text-caption text-muted-foreground"
            >
              {tool}
            </li>
          ))}
        </ul>
      ) : null}
      <SuggestionChips
        label={m.agents_suggestions_label()}
        suggestions={agent.suggestions}
        disabled={disabled}
        onSelect={onSelect}
        className="mt-2.5 justify-center"
      />
    </div>
  )
}

/** 读取历史时（设计稿 Main.dc.html 的 loading） */
export function AgentThreadSkeleton() {
  return (
    <div className="flex flex-col gap-6 pt-2" role="status" aria-label={m.agents_loading()}>
      <span className="h-10 w-3/4 max-w-75 animate-pulse self-end rounded-xl bg-active motion-reduce:animate-none" />
      <div className="flex items-start gap-3">
        <span className="size-7 shrink-0 animate-pulse rounded-full bg-active motion-reduce:animate-none" />
        <span className="flex flex-1 flex-col gap-2">
          <span className="h-8.5 animate-pulse rounded-lg bg-active motion-reduce:animate-none" />
          <span className="h-3 w-11/12 animate-pulse rounded-md bg-active motion-reduce:animate-none" />
          <span className="h-3 w-2/3 animate-pulse rounded-md bg-active motion-reduce:animate-none" />
        </span>
      </div>
    </div>
  )
}

function ThreadError() {
  return (
    <div role="alert" className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3">
      <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" strokeWidth={1.5} />
      <span className="flex-1">{m.agents_thread_error()}</span>
      <Button type="button" variant="outline" size="sm" onClick={() => window.location.reload()}>
        {m.agents_retry()}
      </Button>
    </div>
  )
}

class ThreadErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.warn('agents.thread.failed', error, info.componentStack)
  }
  override render() {
    return this.state.failed ? <ThreadError /> : this.props.children
  }
}

// ---------------------------------------------------------------------------
// 对话（连接实例后渲染）
// ---------------------------------------------------------------------------

interface AgentChatProps {
  readonly slug: string
  readonly conversationId: string
  readonly agent: AgentOption
  readonly models: readonly PickerModel[]
  readonly modelId: string | undefined
  readonly onModelChange: (id: string) => void
  readonly modelError: string | null
  readonly maxSteps: number
  readonly maxTurnCredits: number | null
  readonly turns: readonly AgentTurnView[]
  readonly balance: number
  readonly readOnly: boolean
  readonly title: string
  readonly onTitle: (title: string) => void
  readonly onTurnEnd: () => void
  readonly inputRef: RefObject<HTMLTextAreaElement | null>
}

type Announce = 'generating' | 'tool' | 'awaiting' | 'done' | 'stopped' | 'failed' | null

function AgentChat({
  slug,
  conversationId,
  agent,
  models,
  modelId,
  onModelChange,
  modelError,
  maxSteps,
  maxTurnCredits,
  turns,
  balance,
  readOnly,
  title,
  onTitle,
  onTurnEnd,
  inputRef,
}: AgentChatProps) {
  const connection = useAgent({ agent: AGENT_ROUTE_NAME, name: conversationId })
  const [draft, setDraft] = useState('')
  const [stopped, setStopped] = useState<string | null>(null)
  const lastSent = useRef('')
  const {
    messages,
    status,
    error,
    sendMessage,
    stop,
    clearError,
    addToolApprovalResponse,
    isServerStreaming,
    isRecovering,
    connectionError,
  } = useAgentChat<unknown, ChatUIMessage>({
    agent: connection,
    getInitialMessages: fetchInitialMessages,
    throttle: THROTTLE_MS,
    onTurnEnd: (event) => {
      // 本轮被拒（余额不足、限流等）时保留草稿，处理后可直接再次发送
      if (event.outcome === 'error') setDraft((current) => current || lastSent.current)
      onTurnEnd()
    },
  })
  const busy = status === 'submitted' || status === 'streaming' || isServerStreaming || isRecovering
  const last = messages.at(-1)
  const lastReply = messages.findLast((message) => message.role === 'assistant')
  const awaiting = !busy && awaitingApproval(last)
  const model = models.find((item) => item.id === modelId)
  const canSend = !readOnly && Boolean(model)

  // 首轮结束后用首条消息作为标题（与文本对话一致）
  const titled = useRef(Boolean(title))
  useEffect(() => {
    if (titled.current || busy) return
    const first = messages.find((message) => message.role === 'user')
    const text = first ? titleFromText(messageText(first)) : ''
    if (!text || !messages.some((message) => message.role === 'assistant')) return
    titled.current = true
    onTitle(text)
    void renameAgentConversation({ data: { slug, conversationId, title: text } })
  }, [busy, messages, slug, conversationId, onTitle])

  function send(value?: string) {
    const text = (value ?? draft).trim()
    if (!text || !canSend || busy) return
    clearError()
    setStopped(null)
    lastSent.current = text
    if (value === undefined) setDraft('')
    void sendMessage({ text })
  }

  function stopTurn() {
    if (lastReply) setStopped(lastReply.id)
    stop()
  }

  // 状态播报：只在阶段变化时写入
  const runningTool =
    busy &&
    last?.role === 'assistant' &&
    last.parts.some(
      (part) =>
        isToolUIPart(part) &&
        (part.state === 'input-available' || part.state === 'approval-responded'),
    )
  const [announce, setAnnounce] = useState<Announce>(null)
  const nextAnnounce: Announce = busy
    ? runningTool
      ? 'tool'
      : 'generating'
    : awaiting
      ? 'awaiting'
      : announce === null
        ? null
        : error
          ? 'failed'
          : stopped
            ? 'stopped'
            : 'done'
  if (nextAnnounce !== announce) setAnnounce(nextAnnounce)
  const announceText = {
    generating: m.chat_ui_announce_generating,
    tool: m.agents_announce_tool,
    awaiting: m.agents_announce_awaiting,
    done: m.chat_ui_announce_done,
    stopped: m.chat_ui_announce_stopped,
    failed: m.chat_ui_announce_failed,
  }

  // 跟随滚动：在底部附近时新内容到达才跟随；自己刚发送的消息总是滚到可见
  const following = useRef(true)
  useEffect(() => {
    const onScroll = () => {
      const root = document.scrollingElement ?? document.documentElement
      following.current =
        root.scrollHeight - window.scrollY - window.innerHeight <= FOLLOW_THRESHOLD_PX
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])
  const lastUserId = messages.findLast((message) => message.role === 'user')?.id
  const previousUserId = useRef(lastUserId)
  useLayoutEffect(() => {
    if (lastUserId !== previousUserId.current) following.current = true
    previousUserId.current = lastUserId
    if (following.current && messages.length)
      window.scrollTo({ top: (document.scrollingElement ?? document.documentElement).scrollHeight })
  }, [messages, lastUserId])

  const renderToolPart = agentToolPartRenderer({
    disabled: readOnly,
    onRespond: (id, approved) => void addToolApprovalResponse({ id, approved }),
  })
  const inputTokens = estimateInputTokens([
    ...messages.map((message) => ({ text: messageText(message) })),
    { text: draft },
  ])
  const reserve = turnReserve(model, { inputTokens, maxSteps, maxTurnCredits })

  return (
    <>
      <div className="@container flex min-w-0 flex-1 flex-col gap-5 pb-4">
        {messages.length > 0 ? (
          <ol aria-label={m.chat_ui_messages()} className="flex min-w-0 flex-col gap-5">
            {messages.map((message) => {
              const live = busy && message === last && message.role === 'assistant'
              const isLastReply = message === lastReply
              const turn =
                message.role === 'assistant' && !live
                  ? turnForMessage(message, isLastReply, turns)
                  : undefined
              const ended =
                stopped === message.id || (isLastReply && turn?.status === 'stopped')
                  ? 'aborted'
                  : isLastReply && !live && (turn?.status === 'failed' || error)
                    ? 'failed'
                    : undefined
              const text = messageText(message)
              const done = message.role === 'assistant' && !live && !awaitingApproval(message)
              return (
                <li
                  key={message.id}
                  data-role={message.role}
                  aria-label={message.role === 'user' ? m.chat_ui_you() : agent.name}
                  className="flex min-w-0 flex-col"
                >
                  <ChatMessageView
                    message={message}
                    live={live}
                    status={ended}
                    renderToolPart={renderToolPart}
                    avatar={AGENT_AVATAR}
                    actions={
                      done && (text || (turn && turn.status !== 'running')) ? (
                        <div className="-ml-1.5 flex min-w-0 flex-wrap items-center gap-0.5">
                          {text ? <CopyReplyButton text={text} /> : null}
                          {turn && turn.status !== 'running' ? (
                            <span
                              className="ml-2 text-caption text-muted-foreground"
                              data-agent-turn={turn.status}
                            >
                              {turnSummary(turn, maxSteps, formatNumber(turn.creditsCharged))}
                            </span>
                          ) : null}
                        </div>
                      ) : undefined
                    }
                  />
                </li>
              )
            })}
          </ol>
        ) : (
          <AgentEmptyState
            agent={agent}
            disabled={busy || !canSend}
            onSelect={(text) => send(text)}
          />
        )}
        <span role="status" className="sr-only" data-agent-announcer="">
          {announce ? announceText[announce]() : ''}
        </span>
      </div>
      <AgentComposerShell>
        {error ? <ChatErrorAlert slug={slug} error={error} inputRef={inputRef} /> : null}
        {connectionError ? (
          <p role="alert" className="text-caption text-destructive">
            {m.agents_connection_error()}
          </p>
        ) : null}
        {modelError ? (
          <p role="alert" className="text-caption text-destructive">
            {modelError}
          </p>
        ) : null}
        {readOnly ? (
          <p role="status" className="text-caption text-muted-foreground">
            {m.chat_ui_read_only()}
          </p>
        ) : null}
        <InputMessage
          value={draft}
          onValueChange={setDraft}
          onSend={() => send()}
          onStop={stopTurn}
          busy={busy}
          disabled={readOnly}
          sendDisabled={!canSend}
          placeholder={awaiting ? m.agents_placeholder_awaiting() : m.agents_placeholder()}
          labels={{ message: m.chat_ui_message(), send: m.chat_ui_send(), stop: m.chat_ui_stop() }}
          textareaRef={inputRef}
          leading={
            <>
              <ModelPicker
                models={models}
                value={modelId}
                onChange={onModelChange}
                disabled={busy || readOnly}
                compact
              />
              <span className="shrink-0 text-caption text-muted-foreground max-sm:hidden">
                {m.agents_max_steps({ steps: maxSteps })}
              </span>
            </>
          }
          trailing={
            <span className="text-caption text-muted-foreground" data-agent-reserve="">
              {reserve === null
                ? m.agents_balance({ balance: formatNumber(balance) })
                : m.agents_reserve({
                    credits: formatNumber(reserve),
                    balance: formatNumber(balance),
                  })}
            </span>
          }
        />
      </AgentComposerShell>
    </>
  )
}

/** 吸底输入区（与文本对话页一致）：底色与所在面板相同，下方为说明 */
function AgentComposerShell({ children }: { children: ReactNode }) {
  const inShell = useAppShellBarAvailable()
  return (
    <div
      className={cn(
        'sticky bottom-0 z-(--z-sticky) -mx-1 px-1 pt-2 pb-5',
        inShell ? 'bg-surface-2' : 'bg-background',
      )}
    >
      <div className="flex min-w-0 flex-col gap-2.5">
        {children}
        <p className="text-center text-caption text-muted-foreground max-sm:hidden">
          {m.agents_disclaimer()}
        </p>
      </div>
    </div>
  )
}

/** 水合前与读取历史时的输入区占位（不可输入） */
function ComposerPlaceholder() {
  return (
    <AgentComposerShell>
      <fieldset disabled className="min-w-0">
        <InputMessage
          value=""
          onValueChange={() => {}}
          onSend={() => {}}
          sendDisabled
          placeholder={m.agents_placeholder()}
          labels={{ message: m.chat_ui_message(), send: m.chat_ui_send(), stop: m.chat_ui_stop() }}
        />
      </fieldset>
    </AgentComposerShell>
  )
}

/**
 * agent 对话页（openspec add-ai-agents 6.2，设计稿 agents/Main.dc.html、Mobile.dc.html）：
 * 720px 居中消息列 + 吸底输入区。水合后经 `useAgent` 连接 `/agents/agent-conversation/<id>`（WebSocket，
 * 前置处理校验身份与归属），`useAgentChat` 负责消息、续流、停止与确认往返；本轮摘要与余额读 PG（getAgentTurns）。
 */
export function AgentChatPage({ slug, page }: { slug: string; page: AgentChatPageData }) {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => setHydrated(true), [])
  const [title, setTitle] = useState(page.conversation.title)
  const [modelKey, setModelKey] = useState(page.conversation.modelKey)
  const [modelError, setModelError] = useState<string | null>(null)
  const [turns, setTurns] = useState(page.turns)
  const [balance, setBalance] = useState(page.balance)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const conversationId = page.conversation.id
  const modelId = page.models.find((model) => model.key === modelKey)?.id

  async function refreshTurns() {
    const next = await getAgentTurns({ data: { slug, conversationId } }).catch(() => null)
    if (!next) return
    setTurns(next.turns)
    setBalance(next.balance)
  }

  async function changeModel(id: string) {
    const previous = modelKey
    const next = page.models.find((model) => model.id === id)
    if (!next) return
    setModelError(null)
    setModelKey(next.key)
    const result = await setAgentConversationModel({ data: { slug, conversationId, modelId: id } })
    if (!result.ok) {
      setModelKey(previous)
      setModelError(createErrorMessage(result.error))
    }
  }

  const fallback = (
    <>
      <div className="flex-1 pb-4">
        <AgentThreadSkeleton />
      </div>
      <ComposerPlaceholder />
    </>
  )

  return (
    <div
      className="mx-auto flex min-h-chat-page w-full min-w-0 max-w-180 flex-col gap-5"
      data-agent-chat=""
    >
      <AgentChatHeader
        slug={slug}
        conversationId={conversationId}
        title={title}
        agent={page.agent}
        modelKey={modelKey}
        readOnly={page.readOnly}
      />
      {hydrated ? (
        <ThreadErrorBoundary>
          <Suspense fallback={fallback}>
            <AgentChat
              slug={slug}
              conversationId={conversationId}
              agent={page.agent}
              models={page.models}
              modelId={modelId}
              onModelChange={(id) => void changeModel(id)}
              modelError={modelError}
              maxSteps={page.maxSteps}
              maxTurnCredits={page.maxTurnCredits}
              turns={turns}
              balance={balance}
              readOnly={page.readOnly}
              title={title}
              onTitle={setTitle}
              onTurnEnd={() => void refreshTurns()}
              inputRef={inputRef}
            />
          </Suspense>
        </ThreadErrorBoundary>
      ) : (
        fallback
      )}
    </div>
  )
}
