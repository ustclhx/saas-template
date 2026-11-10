import { Button, cn } from '@saas/ui'
import { useState } from 'react'
import { m } from '../../paraglide/messages.js'
import type { MessageFeedbackValue } from './feedback.ts'

/**
 * 推荐追问与消息评分的最小可用实现（add-subject-chat tasks.md 6.1）。
 * 接口见 change design.md 决策 9；最终视觉由 add-ui-design-system 8.6 的展示组件替换，
 * 替换时保持 props 不变。
 */

export interface SuggestionChipsProps {
  /** 已本地化的问题 */
  readonly suggestions: readonly string[]
  /** 生成中或只读空间 */
  readonly disabled?: boolean
  /** 立即作为用户消息发送；问题本身不写入历史 */
  onSelect(text: string): void
  /** 无障碍分组名 */
  readonly label?: string
  readonly className?: string
}

export function SuggestionChips({
  suggestions,
  disabled,
  onSelect,
  label,
  className,
}: SuggestionChipsProps) {
  if (suggestions.length === 0) return null
  return (
    <ul
      aria-label={label ?? m.subject_chat_suggestions()}
      className={cn('flex flex-wrap gap-2', className)}
    >
      {suggestions.map((text) => (
        <li key={text}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-auto whitespace-normal text-left"
            disabled={disabled}
            onClick={() => onSelect(text)}
          >
            {text}
          </Button>
        </li>
      ))}
    </ul>
  )
}

export interface MessageFeedbackProps {
  readonly messageId: string
  /** null = 未评分 */
  readonly value: MessageFeedbackValue | null
  readonly disabled?: boolean
  /** null = 撤销；失败时 reject，组件回滚并提示 */
  onChange(next: MessageFeedbackValue | null): Promise<void>
}

export function MessageFeedback({ messageId, value, disabled, onChange }: MessageFeedbackProps) {
  const [current, setCurrent] = useState(value)
  const [comment, setComment] = useState(value?.comment ?? '')
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  async function save(next: MessageFeedbackValue | null) {
    const previous = current
    setCurrent(next)
    setPending(true)
    setStatus(null)
    try {
      await onChange(next)
      setStatus(next?.comment ? m.subject_chat_feedback_saved() : null)
      if (!next) setComment('')
    } catch {
      setCurrent(previous)
      setStatus(m.subject_chat_feedback_failed())
    } finally {
      setPending(false)
    }
  }

  function rate(rating: MessageFeedbackValue['rating']) {
    // 再次点击同一评分即撤销
    if (current?.rating === rating) {
      setOpen(false)
      void save(null)
      return
    }
    setOpen(rating === 'down' || Boolean(comment))
    void save({ rating, comment: comment.trim() || null })
  }

  const busy = disabled || pending
  return (
    <fieldset className="grid min-w-0 gap-2">
      <legend className="sr-only">{m.subject_chat_feedback()}</legend>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant={current?.rating === 'up' ? 'default' : 'ghost'}
          aria-pressed={current?.rating === 'up'}
          disabled={busy}
          onClick={() => rate('up')}
        >
          {m.subject_chat_feedback_up()}
        </Button>
        <Button
          type="button"
          size="sm"
          variant={current?.rating === 'down' ? 'default' : 'ghost'}
          aria-pressed={current?.rating === 'down'}
          disabled={busy}
          onClick={() => rate('down')}
        >
          {m.subject_chat_feedback_down()}
        </Button>
        {current ? (
          <Button
            type="button"
            size="sm"
            variant="link"
            disabled={busy}
            onClick={() => {
              setOpen(false)
              void save(null)
            }}
          >
            {m.subject_chat_feedback_undo()}
          </Button>
        ) : null}
      </div>
      {current && open ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void save({ rating: current.rating, comment: comment.trim() || null })
          }}
        >
          <label className="grid gap-1 text-sm" htmlFor={`feedback-${messageId}`}>
            {m.subject_chat_feedback_comment()}
            <textarea
              id={`feedback-${messageId}`}
              className="min-h-16 rounded-md border bg-transparent p-2"
              maxLength={1000}
              value={comment}
              disabled={busy}
              onChange={(event) => setComment(event.target.value)}
            />
          </label>
          <Button type="submit" size="sm" className="w-fit" disabled={busy}>
            {m.subject_chat_feedback_submit()}
          </Button>
        </form>
      ) : null}
      {status ? (
        <p role="status" className="text-muted-foreground text-sm">
          {status}
        </p>
      ) : null}
    </fieldset>
  )
}
