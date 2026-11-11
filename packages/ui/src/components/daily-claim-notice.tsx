// 模板新增（openspec add-ui-design-system tasks 8.6，设计稿 Workbench.dc.html / WorkbenchMobile.dc.html 顶部的
// 「今日奖励可领取」条）：每日领取提示。纯展示：领取与去重由调用方的数据层负责，组件只呈现状态并回调。
// 状态：available（可领取，显示领取按钮）、pending（领取中）、claimed（已到账，显示徽标）、error（失败可重试）。
import { Check, Gift, X } from 'lucide-react'
import { cn } from '../lib/utils.ts'
import { Badge } from './badge.tsx'
import { Button } from './button.tsx'

type DailyClaimStatus = 'available' | 'pending' | 'claimed' | 'error'

interface DailyClaimLabels {
  /** 领取按钮，如「领取 10 积分」 */
  claim: string
  /** 已领取徽标，如「今日已领取」 */
  claimed: string
  /** 关闭按钮的可读名称；传了 onDismiss 时必填 */
  dismiss?: string
}

interface DailyClaimNoticeProps {
  status: DailyClaimStatus
  /** 如「今日登录奖励可领取」/「已领取今日奖励」，随状态由调用方给出 */
  title: string
  /** 如「每天可领取 10 积分，按 UTC 日计算。」/「10 积分已到账，明天再来。」 */
  description: string
  labels: DailyClaimLabels
  /** 手动领取；自动发放的项目不传，available 状态也不显示按钮 */
  onClaim?: () => void
  /** 关闭提示（如自动到账后的一次性通知） */
  onDismiss?: () => void
  /** error 状态的说明，以危险色显示在描述下方 */
  error?: string
  /** 紧凑布局（手机顶部）：图标不加圆底，内边距更小 */
  compact?: boolean
  className?: string
}

function DailyClaimNotice({
  status,
  title,
  description,
  labels,
  onClaim,
  onDismiss,
  error,
  compact = false,
  className,
}: DailyClaimNoticeProps) {
  const canClaim = onClaim && status !== 'claimed'
  return (
    <section
      role="status"
      aria-label={title}
      data-status={status}
      className={cn(
        'flex min-w-0 items-center rounded-xl border bg-card',
        compact ? 'gap-2.5 py-2.5 pr-2.5 pl-3' : 'gap-3 py-3 pr-3 pl-4',
        className,
      )}
    >
      {compact ? (
        <Gift aria-hidden className="size-4.5 shrink-0" strokeWidth={1.5} />
      ) : (
        <span
          aria-hidden
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-active"
        >
          <Gift className="size-4" strokeWidth={1.5} />
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium text-body">{title}</span>
        <span className="text-caption text-muted-foreground">{description}</span>
        {status === 'error' && error ? (
          <span className="text-caption text-destructive">{error}</span>
        ) : null}
      </div>
      {status === 'claimed' ? (
        <Badge color="green" className="shrink-0">
          <Check aria-hidden className="size-3 text-success" strokeWidth={2.5} />
          {labels.claimed}
        </Badge>
      ) : canClaim ? (
        <Button
          type="button"
          size="sm"
          className="shrink-0"
          loading={status === 'pending'}
          onClick={onClaim}
        >
          {labels.claim}
        </Button>
      ) : null}
      {onDismiss && labels.dismiss ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-label={labels.dismiss}
          onClick={onDismiss}
        >
          <X aria-hidden />
        </Button>
      ) : null}
    </section>
  )
}

export type { DailyClaimLabels, DailyClaimNoticeProps, DailyClaimStatus }
export { DailyClaimNotice }
