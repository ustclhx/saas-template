// 模板新增（openspec add-ui-design-system tasks 8.6，设计稿 docs/design-system/prototypes/ui-review/Reader.dc.html
// 「就这份报告提问」卡片与 ReaderMobile.dc.html 的悬浮按钮、底部抽屉）：嵌入式对话外壳。
// 纯展示：只负责入口、面板开合、标题栏与滚动区，对话内容（消息、推荐问题、输入框）由调用方作为 children 传入。
// 两种变体：
// - inline（Reader 画板）：≥ md 在正文流中渲染为卡片，始终显示；< md 为悬浮按钮 + 模态底部抽屉。
// - panel：≥ md 为悬浮按钮 + 右侧非模态侧面板（页面仍可操作）；< md 同样为悬浮按钮 + 模态底部抽屉。
// 面板 / 抽屉关闭时卸载 children（对话状态由调用方保存）；打开期间不随断点切换模态，避免子树重挂载。
import { MessageCircle, Sparkles, X } from 'lucide-react'
import { AnimatePresence, m as motion, useReducedMotion } from 'motion/react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import {
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { spring } from '../lib/springs.ts'
import { surfaceClasses } from '../lib/surface-classes.ts'
import { SurfaceProvider, useSurface } from '../lib/surface-context.tsx'
import { cn } from '../lib/utils.ts'
import { Button } from './button.tsx'

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect
// 与 Tailwind md 断点一致：小于 768px 为手机底部抽屉
const MOBILE_QUERY = '(max-width: 767px)'

function subscribeMobile(onChange: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY)
  mql.addEventListener('change', onChange)
  return () => mql.removeEventListener('change', onChange)
}
const mobileSnapshot = () => window.matchMedia(MOBILE_QUERY).matches
// 服务端按桌面渲染；水合时先用服务端值、随后切到客户端值，不产生水合不一致。客户端新挂载时直接读 matchMedia。
const mobileServerSnapshot = () => false

/** 位于带该属性元素内的 Esc 由内部处理（如消息评分的反馈表单），不关闭外层面板 */
const ESCAPE_SCOPE = '[data-escape-scope]'

interface EmbeddedChatLabels {
  /** 悬浮按钮文字，如「就报告提问」 */
  trigger: string
  /** 面板标题，如「就这份报告提问」；同时是对话框 / 卡片的可读名称 */
  title: string
  /** 关闭按钮的可读名称 */
  close: string
}

type EmbeddedChatVariant = 'inline' | 'panel'

interface EmbeddedChatProps {
  labels: EmbeddedChatLabels
  /** 对话内容：推荐问题、消息列表等 */
  children: ReactNode
  /** inline：≥ md 为正文中的卡片；panel：≥ md 为右侧侧面板。< md 两者都是悬浮按钮 + 底部抽屉。默认 panel */
  variant?: EmbeddedChatVariant
  /** 受控打开（面板 / 抽屉）；不传时组件自己管理 */
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** 标题旁的对象标签，如 `<Badge>季度报告</Badge>` */
  badge?: ReactNode
  /** 标题栏右侧的操作，如「在对话中打开」链接 */
  headerAction?: ReactNode
  /** 底部固定区（输入框、预计消耗说明等），不随消息滚动 */
  footer?: ReactNode
  /** 是否显示悬浮按钮；页面自带入口时传 false 并受控打开 */
  showTrigger?: boolean
  className?: string
}

function EmbeddedChat({
  labels,
  children,
  variant = 'panel',
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
  badge,
  headerAction,
  footer,
  showTrigger = true,
  className,
}: EmbeddedChatProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const liveMobile = useSyncExternalStore(subscribeMobile, mobileSnapshot, mobileServerSnapshot)
  const requestedOpen = controlledOpen ?? uncontrolledOpen
  // 打开期间冻结模态与否：Radix 的模态 / 非模态内容是不同组件，切换会让 children 重新挂载
  const frozenMobile = useRef(liveMobile)
  if (!requestedOpen) frozenMobile.current = liveMobile
  const mobile = requestedOpen ? frozenMobile.current : liveMobile
  // inline 变体在桌面始终以卡片显示，面板不打开
  const inlineCard = variant === 'inline' && !mobile
  const open = requestedOpen && !inlineCard

  const panelRef = useRef<HTMLDivElement | null>(null)
  // 关闭前焦点是否在面板内：非模态面板只有这时才把焦点还回去（焦点已在页面其他位置时不抢）
  const focusInsideOnClose = useRef(true)
  const setOpen = (next: boolean) => {
    if (!next) focusInsideOnClose.current = !!panelRef.current?.contains(document.activeElement)
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const reduceMotion = useReducedMotion() ?? false
  const substrate = useSurface()
  const level = Math.min(substrate + 2, 8)
  const titleId = useId()
  // 没有悬浮按钮（受控打开）时，关闭后把焦点还给打开前的元素
  const returnFocusRef = useRef<HTMLElement | null>(null)
  useIsoLayoutEffect(() => {
    if (open) returnFocusRef.current = document.activeElement as HTMLElement | null
  }, [open])

  const hidden = mobile ? { y: '100%' } : { x: '100%' }
  const shown = mobile ? { y: 0 } : { x: 0 }

  return (
    <>
      {variant === 'inline' ? (
        // 服务端与水合前按 CSS 断点显示：< md 隐藏卡片，避免手机首屏闪现
        <section
          aria-labelledby={titleId}
          data-embedded-chat="inline"
          className={cn(
            'hidden min-w-0 flex-col rounded-xl border bg-card shadow-sm md:flex print:hidden',
            className,
          )}
        >
          <div className="flex items-center gap-2.5 border-b px-4 py-3.5">
            <span
              aria-hidden
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
            >
              <Sparkles className="size-3" strokeWidth={2} />
            </span>
            <h2 id={titleId} className="m-0 min-w-0 truncate font-semibold text-subtitle">
              {labels.title}
            </h2>
            {badge}
            <span className="flex-1" />
            {headerAction}
          </div>
          {inlineCard ? (
            <div className="flex min-w-0 flex-col gap-4 p-4">
              {children}
              {footer}
            </div>
          ) : null}
        </section>
      ) : null}
      <DialogPrimitive.Root open={open} onOpenChange={setOpen} modal={mobile}>
        {showTrigger ? (
          <DialogPrimitive.Trigger asChild>
            <Button
              type="button"
              leadingIcon={MessageCircle}
              data-embedded-chat-trigger=""
              // 打开时隐藏但保留：Radix 关闭后把焦点还给它；inline 变体在桌面不显示
              className={cn(
                'fixed right-4 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] z-(--z-sticky) h-11 rounded-full pr-4 pl-3.5 shadow-surface-5 before:rounded-full',
                'print:hidden',
                variant === 'inline' && 'md:hidden',
                open && 'invisible',
              )}
            >
              {labels.trigger}
            </Button>
          </DialogPrimitive.Trigger>
        ) : null}
        <MotionFeatures>
          <AnimatePresence>
            {open ? (
              <DialogPrimitive.Portal key="embedded-chat" forceMount>
                {mobile ? (
                  <DialogPrimitive.Overlay asChild forceMount>
                    <motion.div
                      data-embedded-chat-overlay=""
                      className="fixed inset-0 z-(--z-overlay) bg-black/40 dark:bg-black/80"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0, transition: spring.moderate.exit }}
                      transition={{ duration: spring.moderate.duration }}
                    />
                  </DialogPrimitive.Overlay>
                ) : null}
                <DialogPrimitive.Content
                  asChild
                  forceMount
                  // 桌面为非模态侧面板：点击页面其他位置或焦点移出都不关闭，只经关闭按钮或 Esc 关闭
                  onInteractOutside={(event) => {
                    if (!mobile) event.preventDefault()
                  }}
                  onEscapeKeyDown={(event) => {
                    const target = event.target as Element | null
                    // 内部表单自己处理 Esc（如收起反馈表单），不关闭面板
                    if (target?.closest?.(ESCAPE_SCOPE)) {
                      event.preventDefault()
                      return
                    }
                    // 非模态面板：焦点不在面板内时，Esc 属于页面其他部分
                    if (!mobile && !panelRef.current?.contains(document.activeElement))
                      event.preventDefault()
                  }}
                  onOpenAutoFocus={(event) => {
                    // 焦点落到面板本身，而不是第一个推荐问题（看起来像被选中）
                    event.preventDefault()
                    panelRef.current?.focus()
                  }}
                  onCloseAutoFocus={(event) => {
                    const inside = focusInsideOnClose.current
                    focusInsideOnClose.current = true
                    const target = returnFocusRef.current
                    returnFocusRef.current = null
                    // 关闭时焦点已在页面其他位置（非模态面板）：保持不动
                    if (!inside) {
                      event.preventDefault()
                      return
                    }
                    if (showTrigger || !target || target === document.body || !target.isConnected)
                      return
                    event.preventDefault()
                    target.focus({ preventScroll: true })
                  }}
                  {...({ 'aria-describedby': undefined } as object)}
                >
                  <motion.div
                    ref={panelRef}
                    tabIndex={-1}
                    data-embedded-chat={mobile ? 'sheet' : 'panel'}
                    className={cn(
                      'fixed z-(--z-modal) flex flex-col overflow-hidden outline-none print:hidden',
                      mobile
                        ? 'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]'
                        : 'top-2 right-2 bottom-2 w-[min(25rem,calc(100vw-1rem))] rounded-xl',
                      surfaceClasses(level, 5),
                      variant === 'panel' && className,
                    )}
                    initial={reduceMotion ? { opacity: 0 } : hidden}
                    animate={reduceMotion ? { opacity: 1 } : shown}
                    exit={
                      reduceMotion
                        ? { opacity: 0, transition: spring.moderate.exit }
                        : { ...hidden, transition: spring.moderate.exit }
                    }
                    transition={spring.moderate}
                  >
                    {mobile ? (
                      <span
                        aria-hidden
                        className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-selected"
                      />
                    ) : null}
                    <div
                      className={cn(
                        'flex shrink-0 items-center gap-2.5',
                        mobile ? 'px-4 pt-2 pb-1' : 'border-b px-4 py-3',
                      )}
                    >
                      <DialogPrimitive.Title className="m-0 min-w-0 truncate font-semibold text-title">
                        {labels.title}
                      </DialogPrimitive.Title>
                      {badge}
                      <span className="flex-1" />
                      {headerAction}
                      <DialogPrimitive.Close asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={labels.close}
                        >
                          <X aria-hidden />
                        </Button>
                      </DialogPrimitive.Close>
                    </div>
                    <SurfaceProvider value={level}>
                      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 py-4">
                        {children}
                      </div>
                      {footer ? <div className="shrink-0 px-4 pb-4">{footer}</div> : null}
                    </SurfaceProvider>
                  </motion.div>
                </DialogPrimitive.Content>
              </DialogPrimitive.Portal>
            ) : null}
          </AnimatePresence>
        </MotionFeatures>
      </DialogPrimitive.Root>
    </>
  )
}

export type { EmbeddedChatLabels, EmbeddedChatProps, EmbeddedChatVariant }
export { EmbeddedChat }
