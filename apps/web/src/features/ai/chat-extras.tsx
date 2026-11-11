import {
  MessageFeedback as FeedbackView,
  InsufficientCreditsDialog,
  SuggestionChips as SuggestionChipsView,
} from '@saas/ui'
import { m } from '../../paraglide/messages.js'
import { getLocale } from '../../paraglide/runtime.js'
import { FEEDBACK_COMMENT_MAX_LENGTH, type MessageFeedbackValue } from './feedback.ts'

/**
 * 推荐追问、消息评分与余额不足弹窗的接线层（add-subject-chat design 决策 9 的接口）：
 * 展示组件来自 `@saas/ui`（add-ui-design-system tasks 8.6），这里只传入按语言的文案，props 与回调不变。
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
  /** 在按钮组上方显示分组名（回复后的「继续追问」） */
  readonly showLabel?: boolean
  readonly className?: string
}

export function SuggestionChips({
  suggestions,
  disabled,
  onSelect,
  label,
  showLabel,
  className,
}: SuggestionChipsProps) {
  return (
    <SuggestionChipsView
      suggestions={suggestions}
      label={label ?? m.subject_chat_suggestions()}
      showLabel={showLabel ?? false}
      disabled={disabled ?? false}
      onSelect={onSelect}
      {...(className ? { className } : {})}
    />
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

export function MessageFeedback({ value, disabled, onChange }: MessageFeedbackProps) {
  return (
    <FeedbackView
      value={value}
      disabled={disabled ?? false}
      commentMaxLength={FEEDBACK_COMMENT_MAX_LENGTH}
      // 后端只保存评分与文字（ai_message_feedback），不传点踩原因选项
      onChange={(next) => onChange(next ? { rating: next.rating, comment: next.comment } : null)}
      labels={{
        group: m.subject_chat_feedback(),
        up: m.subject_chat_feedback_up(),
        down: m.subject_chat_feedback_down(),
        question: m.chat_ui_feedback_question(),
        comment: m.subject_chat_feedback_comment(),
        submit: m.subject_chat_feedback_submit(),
        cancel: m.common_cancel(),
        edit: m.chat_ui_feedback_edit(),
        saved: m.subject_chat_feedback_saved(),
        failed: m.subject_chat_feedback_failed(),
      }}
    />
  )
}

export const formatNumber = (value: number) => new Intl.NumberFormat(getLocale()).format(value)

/** 余额不足弹窗（INSUFFICIENT_CREDITS 的 estimatedCredits / availableCredits），两个入口由调用方跳转 */
export function CreditsDialog({
  open,
  onOpenChange,
  estimatedCredits,
  availableCredits,
  onBuyPacks,
  onSubscribe,
}: {
  open: boolean
  onOpenChange(open: boolean): void
  estimatedCredits: number
  availableCredits: number
  onBuyPacks(): void
  /** 项目没有订阅套餐时不传，弹窗只显示购买积分包 */
  onSubscribe?: (() => void) | undefined
}) {
  return (
    <InsufficientCreditsDialog
      open={open}
      onOpenChange={onOpenChange}
      estimatedCredits={estimatedCredits}
      availableCredits={availableCredits}
      onBuyPacks={onBuyPacks}
      {...(onSubscribe ? { onSubscribe } : {})}
      // 弹窗由接口错误打开时焦点可能在 body：关闭后回到对话输入框
      fallbackFocus={() => document.getElementById('chat-input')}
      labels={{
        title: m.billing_credit_guide_title(),
        description: m.chat_ui_credits_description(),
        estimated: m.chat_ui_credits_estimated(),
        available: m.chat_ui_credits_available(),
        credits: (value) => m.chat_ui_credits_value({ count: formatNumber(value) }),
        shortfall: (missing) => m.chat_ui_credits_shortfall({ count: formatNumber(missing) }),
        buyPacks: m.billing_credit_guide_packs(),
        subscribe: m.chat_ui_credits_subscribe(),
        close: m.chat_ui_close(),
      }}
    />
  )
}
