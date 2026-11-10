import { Button, cn } from '@saas/ui'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { FormAlert } from '../auth/auth-layout.tsx'
import { HydratedControls } from '../workspace/components.tsx'
import { SuggestionChips } from './chat-extras.tsx'
import { ChatPage } from './chat-page.tsx'
import type { MessageFeedbackValue } from './feedback.ts'
import { getPickerModels } from './model-picker.functions.ts'
import type { PickerModel } from './model-picker.ts'
import {
  getSubjectChat,
  startSubjectConversation,
  startTemporarySubjectConversation,
} from './subject-chat.functions.ts'
import type { SubjectChatData } from './subject-chat.server.ts'

/**
 * 嵌入式对象对话（add-subject-chat tasks.md 6.1，specs/ai-chat「对话绑定业务对象」）。
 *
 * `<SubjectChat slug subjectType subjectId />` 可放在任意 App 页面（如报告页底部）：
 * 挂载后读取对象对话数据与可选模型，默认进入最近一个对话；还没有对话时显示开场推荐问题，
 * 第一次发送时由服务端构建上下文并新建对话，再把这条消息发出。发送复用 `POST /api/ai/chat`
 * 的流协议、计费与模型选择。最终视觉由 add-ui-design-system 8.6 替换，props 保持不变。
 */

export interface SubjectChatProps {
  readonly slug: string
  readonly subjectType: string
  readonly subjectId: string
  readonly className?: string | undefined
}

type Loaded = SubjectChatData & { readOnly: boolean; models: readonly PickerModel[] }

export function SubjectChat({ slug, subjectType, subjectId, className }: SubjectChatProps) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'error'; notFound: boolean }
    | { status: 'ready'; data: Loaded }
  >({ status: 'loading' })
  const [conversationId, setConversationId] = useState<string | undefined>()

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    Promise.all([
      getSubjectChat({
        data: {
          slug,
          subject: { type: subjectType, id: subjectId },
          ...(conversationId ? { conversationId } : {}),
        },
      }),
      getPickerModels({ data: { slug, kind: 'text' } }),
    ])
      .then(([chat, models]) => {
        if (!cancelled) setState({ status: 'ready', data: { ...chat, models } })
      })
      .catch((error: unknown) => {
        // 越权、未注册与不存在的对象都以 404（router notFound）返回
        const notFound = typeof error === 'object' && error !== null && 'isNotFound' in error
        if (!cancelled) setState({ status: 'error', notFound })
      })
    return () => {
      cancelled = true
    }
  }, [slug, subjectType, subjectId, conversationId])

  if (state.status === 'loading')
    return (
      <p role="status" className={cn('text-muted-foreground text-sm', className)}>
        {m.subject_chat_loading()}
      </p>
    )
  if (state.status === 'error')
    return (
      <div className={className}>
        <FormAlert
          message={state.notFound ? m.subject_chat_not_found() : m.subject_chat_load_failed()}
        />
      </div>
    )
  return (
    <SubjectChatView
      className={className}
      slug={slug}
      data={state.data}
      models={state.data.models}
      start={async () => {
        const result = await startSubjectConversation({
          data: { slug, subject: { type: subjectType, id: subjectId } },
        })
        if (!result.ok) throw new Error(result.error)
        return result.result.id
      }}
      onSelectConversation={setConversationId}
    />
  )
}

/**
 * 对象对话视图：已有对话时渲染对话；没有时显示开场推荐与输入框，第一次发送前调用 `start`
 * 新建对话。临时上下文页与 `SubjectChat` 共用。
 */
export function SubjectChatView({
  slug,
  data,
  models,
  start,
  onSelectConversation,
  className,
}: {
  slug: string
  data: SubjectChatData & { readOnly: boolean }
  models: readonly PickerModel[]
  /** 新建对话并返回其 ID；为 undefined 时不允许新建（如临时令牌已过期） */
  start: (() => Promise<string>) | undefined
  onSelectConversation?: ((id: string) => void) | undefined
  className?: string | undefined
}) {
  const [active, setActive] = useState<{ id: string; title: string; autoSend?: string } | null>(
    data.conversation,
  )
  const [startError, setStartError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [draft, setDraft] = useState('')
  const subject = data.subject
  const canStart = start !== undefined && !data.readOnly && models.length > 0

  async function begin(text: string) {
    if (!start || pending || !text.trim()) return
    setPending(true)
    setStartError(null)
    try {
      const id = await start()
      setActive({ id, title: subject.title ?? '', autoSend: text.trim() })
    } catch {
      setStartError(m.subject_chat_start_failed())
    } finally {
      setPending(false)
    }
  }

  return (
    <section
      className={cn('grid gap-4', className)}
      aria-label={subject.title ?? subject.label}
      data-subject-type={subject.type}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border px-2 py-0.5 text-muted-foreground text-xs">
          {subject.label}
        </span>
        {subject.title ? <h2 className="mr-auto font-semibold">{subject.title}</h2> : null}
        {active && start ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!canStart}
            onClick={() => {
              setActive(null)
              setDraft('')
            }}
          >
            {m.subject_chat_new()}
          </Button>
        ) : null}
      </header>
      {data.conversations.length > 1 && onSelectConversation ? (
        <details className="text-sm">
          <summary>{m.subject_chat_history()}</summary>
          <ul className="grid gap-1 pt-2">
            {data.conversations.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="underline"
                  aria-current={item.id === active?.id}
                  onClick={() => onSelectConversation(item.id)}
                >
                  {item.title || 'New chat'}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {active ? (
        <ChatPage
          key={active.id}
          slug={slug}
          variant="embedded"
          conversation={active}
          storedMessages={active.id === data.conversation?.id ? data.messages : []}
          models={models}
          readOnly={data.readOnly}
          openingSuggestions={subject.suggestions}
          defaultModelKey={subject.defaultModelKey}
          initialFeedback={
            active.id === data.conversation?.id
              ? (data.feedback as Record<string, MessageFeedbackValue>)
              : {}
          }
          autoSend={active.autoSend}
        />
      ) : (
        <div className="grid gap-3">
          {subject.suggestions.length > 0 ? (
            <SuggestionChips
              suggestions={subject.suggestions}
              disabled={!canStart || pending}
              onSelect={(text) => void begin(text)}
            />
          ) : (
            <p>{m.subject_chat_empty()}</p>
          )}
          <HydratedControls>
            <form
              className="grid gap-2"
              aria-label="Send a message"
              onSubmit={(event) => {
                event.preventDefault()
                void begin(draft)
              }}
            >
              <textarea
                aria-label="Message"
                className="min-h-20 rounded-md border bg-transparent p-2"
                value={draft}
                disabled={!canStart || pending}
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button
                type="submit"
                className="w-fit"
                disabled={!canStart || pending || !draft.trim()}
              >
                Send
              </Button>
            </form>
          </HydratedControls>
          <FormAlert message={startError} />
        </div>
      )}
    </section>
  )
}

/** 临时上下文页（`/app/$slug/chat/context?token=`）：无效、过期引导与对话 */
export function TemporarySubjectChat({
  slug,
  token,
  page,
  models,
}: {
  slug: string
  token: string
  page:
    | { status: 'invalid'; readOnly: boolean }
    | ({ status: 'expired'; returnTo: string; readOnly: boolean } & Partial<SubjectChatData>)
    | ({ status: 'ok'; returnTo: string; readOnly: boolean } & SubjectChatData)
  models: readonly PickerModel[]
}) {
  if (page.status === 'invalid')
    return (
      <section className="grid gap-3">
        <FormAlert message={m.subject_chat_context_invalid()} />
        <Link to="/app/$slug/chat" params={{ slug }} className="underline">
          {m.subject_chat_context_back_app()}
        </Link>
      </section>
    )
  const back = (
    // returnTo 已在签发时校验为站内路径
    <a href={page.returnTo} className="underline">
      {m.subject_chat_context_back()}
    </a>
  )
  if (page.status === 'expired' && !page.subject)
    return (
      <section className="grid gap-3">
        <p role="status">{m.subject_chat_context_expired()}</p>
        {back}
      </section>
    )
  const data = page as SubjectChatData & { readOnly: boolean }
  return (
    <section className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-semibold text-2xl">{m.subject_chat_context_title()}</h1>
        {back}
      </div>
      {page.status === 'expired' ? (
        <p role="status">{m.subject_chat_context_expired_existing()}</p>
      ) : null}
      <SubjectChatView
        slug={slug}
        data={data}
        models={models}
        start={
          page.status === 'ok'
            ? async () => {
                const result = await startTemporarySubjectConversation({ data: { slug, token } })
                if (!result.ok) throw new Error(result.error)
                if (result.result.status !== 'ok') throw new Error(result.result.status)
                return result.result.id
              }
            : undefined
        }
      />
    </section>
  )
}
