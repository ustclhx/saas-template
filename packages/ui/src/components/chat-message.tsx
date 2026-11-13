// 来源：fluid-functionalism chat-message（2026-11，https://www.fluidfunctionalism.com/r/chat-message.json，MIT）
// 适配：包内相对路径、去掉 "use client"、`m as motion` + MotionFeatures；其余改动见 packages/ui/UPSTREAM.md
// 模板改动（openspec add-ai-chat-components design D1，设计稿 docs/design-system/prototypes/chat-components/Main.dc.html、
// States.dc.html、Mobile.dc.html、Embedded.dc.html）：
// - 角色属性沿用上游 `from`（design D1 写作 `role`：与 HTML role 属性同名，Biome a11y 规则会把调用处当作无效 ARIA role）；
// - 用户消息为右侧 12px 圆角的 secondary 底气泡（上游为 accent 混色），最宽 80%（窄屏与 compact 85%）；
//   助手消息为左侧 28px 头像（窄屏与 compact 24px）+ 内容列，正文无底色；
// - 新增 `status`（streaming / aborted / failed / incomplete / retrying）：流式中正文末尾显示闪烁光标，
//   其余四种在正文下方显示状态徽标与可选说明 `statusDetail`，已生成的正文保留；状态文字经 `statusLabel` 传入；
// - 操作区（`actions`）始终可见（设计稿），上游悬停才显示；时间戳 `time` 与附件 `files` 不移植；
// - 去掉上游的 `layout="position"`（需要 domMax，本包统一 domAnimation），只保留入场动效；`entrance={false}`
//   时不播放（首屏已有的历史消息）；减少动态效果时由 UiRoot 的 MotionConfig 去掉位移与缩放，只保留淡入；
// - 长单词与长链接按 `overflow-wrap: anywhere` 换行，不撑出容器。
import { CircleAlert, LoaderCircle, Sparkle } from 'lucide-react'
import { type MotionStyle, m as motion } from 'motion/react'
import { Children, forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { useShape } from '../lib/shape-context.tsx'
import { type SizeVariant, typeClass, useSizeVariant } from '../lib/size-context.tsx'
import { spring } from '../lib/springs.ts'
import { cn } from '../lib/utils.ts'

type ChatMessageRole = 'user' | 'assistant'
/** 在正文下方显示徽标的结束状态 */
type ChatMessageEndStatus = 'aborted' | 'failed' | 'incomplete' | 'retrying'
type ChatMessageStatus = 'streaming' | ChatMessageEndStatus

type ChatMessageStatusProps =
  | {
      /** 无状态（已完成）或流式生成中（正文末尾显示光标） */
      status?: 'streaming'
      statusLabel?: never
      statusDetail?: never
    }
  | {
      status: ChatMessageEndStatus
      /** 徽标文字，如「已停止」「失败」（必填，组件不带默认文案） */
      statusLabel: ReactNode
      /** 徽标右侧的说明，如失败原因 */
      statusDetail?: ReactNode
    }

// 与 motion 同名的事件属性（动画 / 拖拽回调）签名不同，不透传
type ChatMessageProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'onAnimationStart' | 'onDrag' | 'onDragStart' | 'onDragEnd'
> &
  ChatMessageStatusProps & {
    /** Who sent the message. Drives alignment and bubble colour. */
    from: ChatMessageRole
    /** 消息内容；助手消息由调用方按内容类型组合（推理、工具调用、正文），依次竖排 */
    children?: ReactNode
    /** 正文下方的操作区，如复制回复与评分 */
    actions?: ReactNode
    /** 助手头像；默认为强调色圆底上的星形图标，传 `false` 不显示 */
    avatar?: ReactNode | false
    /** 是否播放入场动效；首屏渲染的历史消息传 false */
    entrance?: boolean
    /** Pins the message to one step of the size ladder. Omitted, it follows the surrounding SizeProvider. */
    size?: SizeVariant
  }

const STATUS_BADGE: Record<ChatMessageEndStatus, string> = {
  aborted: 'bg-secondary text-muted-foreground',
  retrying: 'bg-secondary text-muted-foreground',
  incomplete: 'bg-warning/10 text-warning dark:bg-warning/15',
  failed: 'bg-destructive/10 text-destructive dark:bg-destructive/15',
}

function StatusIcon({ status }: { status: ChatMessageEndStatus }) {
  if (status === 'aborted') {
    // 设计稿：实心小方块（与停止按钮同一图形）
    return <span aria-hidden="true" className="size-2 shrink-0 rounded-xs bg-current" />
  }
  if (status === 'failed') return <CircleAlert aria-hidden="true" size={12} strokeWidth={2} />
  if (status === 'retrying') {
    return (
      <LoaderCircle
        aria-hidden="true"
        size={12}
        strokeWidth={2}
        className="animate-spin motion-reduce:animate-none"
      />
    )
  }
  return null
}

/** 纯文本子节点包进段落，流式光标（globals.css 的 chat-caret）才能接在文字之后 */
function wrapText(children: ReactNode) {
  return Children.map(children, (child) =>
    typeof child === 'string' || typeof child === 'number' ? (
      <p className="whitespace-pre-wrap">{child}</p>
    ) : (
      child
    ),
  )
}

const ChatMessage = forwardRef<HTMLDivElement, ChatMessageProps>(
  (
    {
      from,
      status,
      statusLabel,
      statusDetail,
      actions,
      avatar,
      entrance = true,
      children,
      size,
      className,
      style,
      ...props
    },
    ref,
  ) => {
    const shape = useShape()
    const compact = useSizeVariant(size) === 'compact'
    const isUser = from === 'user'
    const endStatus = status && status !== 'streaming' ? status : null
    const hasContent = children != null && children !== '' && children !== false

    const statusRow = endStatus && (
      <div data-chat-status={endStatus} className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={cn(
            'inline-flex h-5 items-center gap-1 rounded-full px-2 font-medium',
            typeClass('caption'),
            STATUS_BADGE[endStatus],
          )}
        >
          <StatusIcon status={endStatus} />
          {statusLabel}
        </span>
        {statusDetail != null && (
          <span className={cn('min-w-0 text-muted-foreground', typeClass('caption'))}>
            {statusDetail}
          </span>
        )}
      </div>
    )

    const actionsRow = actions != null && (
      // 设计稿：28px 图标按钮，左缘外移 6px 与正文对齐
      <div
        data-chat-actions=""
        className={cn('flex items-center gap-0.5', isUser ? 'self-end' : '-ml-1.5')}
      >
        {actions}
      </div>
    )

    return (
      <MotionFeatures>
        <motion.div
          ref={ref}
          data-chat-role={from}
          data-status={status}
          aria-busy={status === 'streaming' || status === 'retrying' ? true : undefined}
          initial={entrance ? { opacity: 0, y: 8, scale: 0.96 } : false}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={spring.moderate}
          style={{
            ...(style as MotionStyle),
            transformOrigin: isUser ? 'bottom right' : 'bottom left',
          }}
          className={cn(
            'flex min-w-0',
            typeClass('subtitle', 'default'),
            isUser
              ? cn(
                  'flex-col items-end gap-1.5 self-end',
                  compact ? 'max-w-17/20' : 'max-w-17/20 sm:max-w-4/5',
                )
              : cn('w-full self-start', compact ? 'gap-2' : 'gap-2 sm:gap-3'),
            className,
          )}
          {...props}
        >
          {isUser ? (
            <>
              {hasContent && (
                <div
                  className={cn(
                    'min-w-0 whitespace-pre-wrap bg-secondary text-foreground wrap-anywhere',
                    shape.container,
                    compact ? 'px-3 py-2.25' : 'px-3 py-2.25 sm:px-3.5 sm:py-2.5',
                  )}
                >
                  {children}
                </div>
              )}
              {statusRow}
              {actionsRow}
            </>
          ) : (
            <>
              {avatar !== false &&
                (avatar ?? (
                  <span
                    aria-hidden="true"
                    data-chat-avatar=""
                    className={cn(
                      'flex shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground',
                      compact ? 'size-6' : 'size-6 sm:size-7',
                    )}
                  >
                    <Sparkle size={compact ? 12 : 14} strokeWidth={2} />
                  </span>
                ))}
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                {hasContent && (
                  <div
                    data-chat-content=""
                    className={cn(
                      'flex min-w-0 flex-col gap-2 text-foreground wrap-anywhere',
                      status === 'streaming' && 'chat-caret',
                    )}
                  >
                    {wrapText(children)}
                  </div>
                )}
                {statusRow}
                {actionsRow}
              </div>
            </>
          )}
        </motion.div>
      </MotionFeatures>
    )
  },
)
ChatMessage.displayName = 'ChatMessage'

export type { ChatMessageEndStatus, ChatMessageProps, ChatMessageRole, ChatMessageStatus }
export { ChatMessage }
