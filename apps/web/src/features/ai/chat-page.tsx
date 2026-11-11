import { useChat } from '@ai-sdk/react'
import { estimateInputTokens } from '@saas/ai/client'
import { type InsufficientCreditsDetails, parseInsufficientCredits } from '@saas/shared'
import { Button, Label } from '@saas/ui'
import { Link, useNavigate } from '@tanstack/react-router'
import { DefaultChatTransport } from 'ai'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { templateConfig } from '../../server/template-config.ts'
import { trackEvent } from '../analytics/track.ts'
import { FormAlert } from '../auth/auth-layout.tsx'
import { pricingSnapshot } from '../marketing/pricing-snapshot.ts'
import { HydratedControls } from '../workspace/components.tsx'
import { CreditsDialog, formatNumber, MessageFeedback, SuggestionChips } from './chat-extras.tsx'
import {
  type ChatMessageStatus,
  type ChatUIMessage,
  chatErrorCode,
  chatErrorMessage,
  chatRequestBody,
  conversationTitle,
  messageReasoning,
  messageRetrying,
  messageText,
  type StoredMessage,
  stopResponseSchema,
  streamingMessageId,
  titleFromText,
  toChatMessages,
} from './conversation.ts'
import { renameConversation } from './conversations.functions.ts'
import type { MessageFeedbackValue } from './feedback.ts'
import type { PickerModel } from './model-picker.ts'
import { CreditEstimateText, ModelPicker } from './model-picker.tsx'
import { getFollowUps, setMessageFeedback } from './subject-chat.functions.ts'

const BILLING_CODES = new Set(['INSUFFICIENT_CREDITS', 'CREDIT_DEBT', 'UPGRADE_REQUIRED'])
// 构建时的公开套餐里明确没有订阅时，余额不足弹窗不显示「订阅」；快照为空（构建时数据库不可达）时保留
const offersSubscriptions =
  pricingSnapshot.plans.length === 0 ||
  pricingSnapshot.plans.some((plan) => plan.type === 'subscription')

/**
 * 对话页（tasks.md 3.1）：`useChat` 经 `POST /api/ai/chat` 流式回复，每轮只提交本轮用户消息；
 * 停止按钮调用 `POST /api/ai/chat/:messageId/stop`（messageId 来自流 start 事件的 metadata），
 * 接口错误码显示为可读提示。
 */
export function ChatPage({
  slug,
  conversation,
  storedMessages,
  models,
  readOnly,
  variant = 'page',
  openingSuggestions = [],
  defaultModelKey,
  initialFeedback = {},
  autoSend,
}: {
  slug: string
  conversation: { id: string; title: string }
  storedMessages: readonly StoredMessage[]
  models: readonly PickerModel[]
  readOnly: boolean
  /** embedded：嵌入其他页面（对象对话），不显示标题栏与返回链接 */
  variant?: 'page' | 'embedded'
  /** 对话无消息时显示的开场推荐问题（add-subject-chat） */
  openingSuggestions?: readonly string[]
  /** 对象 provider 给出的默认计费模型 key；不可用时回落到第一个模型 */
  defaultModelKey?: string | null | undefined
  /** 当前用户对历史回复的评分 */
  initialFeedback?: Readonly<Record<string, MessageFeedbackValue>>
  /** 挂载后立即发送的第一条消息（对象对话新建后发送用户已输入或点击的问题） */
  autoSend?: string | undefined
}) {
  const [modelId, setModelId] = useState(
    (models.find((m) => m.key === defaultModelKey) ?? models[0])?.id,
  )
  const [feedback, setFeedback] = useState(initialFeedback)
  // 最近一条回复的后续推荐问题；推荐问题只在界面上显示，不进入历史
  const [followUps, setFollowUps] = useState<{ messageId: string; questions: string[] } | null>(
    null,
  )
  const model = models.find((m) => m.id === modelId)
  const canToggleThinking = templateConfig.ai.text.thinking.userToggle && model?.supportsThinking
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(templateConfig.ai.text.thinking.default === 'on')
  const [title, setTitle] = useState(conversation.title)
  // 停止接口返回的消息状态，覆盖流中的状态显示
  const [ended, setEnded] = useState<Record<string, ChatMessageStatus>>({})
  const [stopError, setStopError] = useState<string | null>(null)
  // transport 只创建一次，发送时读取当前选择的模型
  const modelRef = useRef(modelId)
  modelRef.current = modelId
  const thinkingRef = useRef(thinking)
  thinkingRef.current = thinking
  const canToggleThinkingRef = useRef(canToggleThinking)
  canToggleThinkingRef.current = canToggleThinking
  const titleRef = useRef(title)

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ChatUIMessage>({
        api: '/api/ai/chat',
        prepareSendMessagesRequest: ({ messages }) => ({
          body: chatRequestBody({
            slug,
            modelId: modelRef.current ?? '',
            conversationId: conversation.id,
            messages,
            ...(canToggleThinkingRef.current ? { thinking: thinkingRef.current } : {}),
          }),
        }),
      }),
    [slug, conversation.id],
  )
  const initialMessages = useMemo(() => toChatMessages(storedMessages), [storedMessages])
  const { messages, sendMessage, status, stop, error, clearError } = useChat<ChatUIMessage>({
    id: conversation.id,
    messages: initialMessages,
    transport,
    onFinish: ({ messages, isError, isAbort }) => {
      if (!isAbort) trackEvent(isError ? 'generate_fail' : 'generate_success')
      const replyId = messages.at(-1)?.metadata?.messageId
      if (!isError && !isAbort && replyId && templateConfig.ai.text.followUps.enabled)
        void getFollowUps({ data: { slug, messageId: replyId } })
          .then((result) => {
            if (result.questions.length)
              setFollowUps({ messageId: replyId, questions: result.questions })
          })
          .catch(() => {})
      // 新建的对话标题为空：首轮回复完成后取首条消息作为标题
      if (isError || isAbort || titleRef.current) return
      const first = messages.find((message) => message.role === 'user')
      const next = first ? titleFromText(messageText(first)) : ''
      if (!next) return
      titleRef.current = next
      setTitle(next)
      void renameConversation({ data: { slug, conversationId: conversation.id, title: next } })
    },
  })

  const busy = status === 'submitted' || status === 'streaming'
  const inputTokens = estimateInputTokens([
    ...messages.map((message) => ({ text: messageText(message) })),
    { text: input },
  ])
  const errorCode = error ? chatErrorCode(error) : undefined
  const insufficientCredits = parseInsufficientCredits(error)
  const blockedByPaywall = errorCode !== undefined && BILLING_CODES.has(errorCode)
  useEffect(() => {
    if (blockedByPaywall) trackEvent('paywall_view')
  }, [blockedByPaywall])
  // 积分不足（带预计消耗与余额）时弹出余额不足弹窗；关闭后可经错误区的按钮再次打开
  const [creditsDialogOpen, setCreditsDialogOpen] = useState(false)
  useEffect(() => {
    setCreditsDialogOpen(Boolean(error && parseInsufficientCredits(error)))
  }, [error])

  function submit(value = input) {
    const text = value.trim()
    if (!text || !modelId || busy || readOnly) return
    setStopError(null)
    setFollowUps(null)
    clearError()
    if (value === input) setInput('')
    trackEvent('generate_start')
    void sendMessage({ text })
  }

  // 对象对话新建后自动发送第一条消息（只发送一次）
  const autoSent = useRef(false)
  useEffect(() => {
    if (!autoSend || autoSent.current || !modelId) return
    autoSent.current = true
    submit(autoSend)
  })

  async function saveFeedback(messageId: string, next: MessageFeedbackValue | null) {
    const result = await setMessageFeedback({
      data: {
        slug,
        messageId,
        rating: next?.rating ?? null,
        ...(next?.comment ? { comment: next.comment } : {}),
        ...(next?.reason ? { reason: next.reason } : {}),
      },
    })
    if (!result.ok) throw new Error(result.error)
    setFeedback((old) => {
      const { [messageId]: _, ...rest } = old
      return result.result ? { ...rest, [messageId]: result.result } : rest
    })
  }

  async function stopReply() {
    const messageId = streamingMessageId(messages, status)
    setStopError(null)
    // 先通知服务端停止上游生成，再中断本地读取（服务端在客户端断开后仍会继续读完模型流）
    const request = messageId
      ? fetch(`/api/ai/chat/${messageId}/stop`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slug }),
        })
      : undefined
    await stop()
    if (!messageId || !request) return
    try {
      const response = await request
      const parsed = stopResponseSchema.safeParse(await response.json())
      if (!response.ok || !parsed.success) throw new Error('stop failed')
      const status = parsed.data.status
      setEnded((old) => ({ ...old, [messageId]: status }))
    } catch {
      setStopError('Could not stop the reply on the server. It may continue in the background.')
    }
  }

  return (
    <div className="grid gap-6">
      {variant === 'page' ? (
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-2xl font-semibold" data-testid="conversation-title">
            {conversationTitle(title)}
          </h2>
          <Link to="/app/$slug/chat" params={{ slug }} className="underline">
            All chats
          </Link>
        </div>
      ) : null}
      <ol aria-label="Messages" className="grid gap-4">
        {messages.map((message) => {
          const live = busy && message === messages.at(-1)
          const status = ended[message.id] ?? message.metadata?.status
          const messageId = message.metadata?.messageId
          return (
            <ChatMessage key={message.id} message={message} status={status} live={live}>
              {message.role === 'assistant' && messageId && !live && status !== 'streaming' ? (
                <MessageFeedback
                  messageId={messageId}
                  value={feedback[messageId] ?? null}
                  disabled={readOnly}
                  onChange={(next) => saveFeedback(messageId, next)}
                />
              ) : null}
            </ChatMessage>
          )
        })}
      </ol>
      {messages.length === 0 ? (
        openingSuggestions.length > 0 ? (
          <SuggestionChips
            suggestions={openingSuggestions}
            disabled={busy || readOnly || !model}
            onSelect={(text) => submit(text)}
          />
        ) : (
          <p>Send a message to start the conversation.</p>
        )
      ) : null}
      {!busy && followUps && followUps.messageId === messages.at(-1)?.metadata?.messageId ? (
        <SuggestionChips
          label={m.subject_chat_follow_ups()}
          showLabel
          suggestions={followUps.questions}
          disabled={readOnly || !model}
          onSelect={(text) => submit(text)}
        />
      ) : null}
      {error ? (
        <div className="grid gap-2">
          <FormAlert message={chatErrorMessage(errorCode)} />
          {insufficientCredits ? (
            <InsufficientCreditsGuide
              slug={slug}
              details={insufficientCredits}
              open={creditsDialogOpen}
              onOpenChange={setCreditsDialogOpen}
            />
          ) : null}
          {!insufficientCredits && errorCode && BILLING_CODES.has(errorCode) ? (
            <Link to="/app/$slug/billing" params={{ slug }} className="underline">
              Go to billing
            </Link>
          ) : null}
        </div>
      ) : null}
      <FormAlert message={stopError} />
      {readOnly ? <p role="status">This workspace is read-only.</p> : null}
      <form
        aria-label="Send a message"
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <HydratedControls>
          <ModelPicker models={models} value={modelId} onChange={setModelId} disabled={busy} />
          {canToggleThinking ? (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={thinking}
                disabled={busy || readOnly}
                onChange={(event) => setThinking(event.target.checked)}
              />
              Thinking
            </label>
          ) : null}
          <p className="grid gap-1">
            <Label htmlFor="chat-input">Message</Label>
            <textarea
              id="chat-input"
              className="min-h-24 rounded-md border p-2"
              value={input}
              disabled={readOnly}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  submit()
                }
              }}
            />
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {busy ? (
              <Button type="button" variant="outline" onClick={() => void stopReply()}>
                Stop
              </Button>
            ) : (
              <Button type="submit" disabled={readOnly || !model || !input.trim()}>
                Send
              </Button>
            )}
            <CreditEstimateText model={model} inputTokens={inputTokens} />
          </div>
        </HydratedControls>
      </form>
    </div>
  )
}

function ChatMessage({
  message,
  status,
  live,
  children,
}: {
  message: ChatUIMessage
  status: ChatMessageStatus | undefined
  live: boolean
  children?: ReactNode
}) {
  const reasoning = templateConfig.ai.text.reasoning.display ? messageReasoning(message) : ''
  const retrying = live && messageRetrying(message)
  const note =
    status === 'aborted'
      ? 'Stopped'
      : status === 'failed'
        ? 'This reply failed. Please try again.'
        : status === 'streaming' && !live
          ? 'Incomplete'
          : null
  return (
    <li className="grid gap-1" data-role={message.role} aria-label={roleName(message.role)}>
      <span className="text-muted-foreground text-sm">{roleName(message.role)}</span>
      {reasoning ? (
        <details className="text-muted-foreground text-sm">
          <summary>Reasoning</summary>
          <p className="whitespace-pre-wrap">{reasoning}</p>
        </details>
      ) : null}
      <p className="whitespace-pre-wrap">{messageText(message)}</p>
      {retrying ? <span role="status">Retrying…</span> : null}
      {note ? <span className="text-muted-foreground text-sm">{note}</span> : null}
      {children}
    </li>
  )
}

const roleName = (role: string) => (role === 'user' ? 'You' : 'Assistant')

/**
 * 积分不足（add-ui-design-system 8.6）：错误区显示数值与「补充积分」按钮，弹窗给出购买积分包与订阅两个入口。
 * 解析与错误提示由 ChatPage 保留。
 */
export function InsufficientCreditsGuide({
  slug,
  details,
  open,
  onOpenChange,
}: {
  slug: string
  details: InsufficientCreditsDetails
  open: boolean
  onOpenChange(open: boolean): void
}) {
  const navigate = useNavigate()
  const goTo = (hash: 'credit-packs' | 'subscriptions') => {
    onOpenChange(false)
    void navigate({ to: '/app/$slug/billing', params: { slug }, hash })
  }
  return (
    <section aria-label={m.billing_credit_guide_title()} className="grid justify-items-start gap-2">
      <p>
        {m.billing_credit_guide_amounts({
          estimatedCredits: formatNumber(details.estimatedCredits),
          availableCredits: formatNumber(details.availableCredits),
        })}
      </p>
      <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(true)}>
        {m.chat_ui_credits_reopen()}
      </Button>
      <CreditsDialog
        open={open}
        onOpenChange={onOpenChange}
        estimatedCredits={details.estimatedCredits}
        availableCredits={details.availableCredits}
        onBuyPacks={() => goTo('credit-packs')}
        onSubscribe={offersSubscriptions ? () => goTo('subscriptions') : undefined}
      />
    </section>
  )
}
