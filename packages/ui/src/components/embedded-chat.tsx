// 模板新增（openspec add-ui-design-system tasks 8.6，设计稿 docs/design-system/prototypes/ui-review/ReaderMobile.dc.html
// 的悬浮按钮与底部抽屉、Reader.dc.html 的「就这份报告提问」面板头部）：嵌入式对话外壳。
// 纯展示：只负责悬浮入口与面板的开合、标题栏和滚动区，对话内容（消息、推荐问题、输入框）由调用方作为 children 传入。
// 桌面（≥ md）为右侧非模态侧面板，页面仍可滚动与操作；手机为模态底部抽屉（遮罩、焦点锁定、Esc / 点遮罩关闭）。
// 打开时悬浮按钮隐藏但保留在页面上，关闭后焦点回到它。
import { MessageCircle, X } from 'lucide-react'
import { AnimatePresence, m as motion, useReducedMotion } from 'motion/react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { MotionFeatures } from '../lib/motion-features.tsx'
import { spring } from '../lib/springs.ts'
import { surfaceClasses } from '../lib/surface-classes.ts'
import { SurfaceProvider, useSurface } from '../lib/surface-context.tsx'
import { cn } from '../lib/utils.ts'
import { Button } from './button.tsx'

const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect
// 与 Tailwind md 断点一致：小于 768px 为手机底部抽屉
const MOBILE_QUERY = '(max-width: 767px)'

function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY)
    const update = () => setMobile(mql.matches)
    update()
    mql.addEventListener('change', update)
    return () => mql.removeEventListener('change', update)
  }, [])
  return mobile
}

interface EmbeddedChatLabels {
  /** 悬浮按钮文字，如「就报告提问」 */
  trigger: string
  /** 面板标题，如「就这份报告提问」；同时是对话框的可读名称 */
  title: string
  /** 关闭按钮的可读名称 */
  close: string
}

interface EmbeddedChatProps {
  labels: EmbeddedChatLabels
  /** 对话内容：推荐问题、消息列表、输入框等 */
  children: ReactNode
  /** 受控打开；不传时组件自己管理 */
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  /** 标题旁的对象标签，如 `<Badge>季度报告</Badge>` */
  badge?: ReactNode
  /** 标题栏右侧的操作，如「在对话中打开」链接 */
  headerAction?: ReactNode
  /** 面板底部固定区（输入框下方的预计消耗说明等），不随消息滚动 */
  footer?: ReactNode
  /** 是否显示悬浮按钮；页面自带入口时传 false 并受控打开 */
  showTrigger?: boolean
  className?: string
}

function EmbeddedChat({
  labels,
  children,
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
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChange?.(next)
  }
  const mobile = useIsMobile()
  const reduceMotion = useReducedMotion() ?? false
  const substrate = useSurface()
  const level = Math.min(substrate + 2, 8)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // 没有悬浮按钮（受控打开）时，关闭后把焦点还给打开前的元素
  const returnFocusRef = useRef<HTMLElement | null>(null)
  useIsoLayoutEffect(() => {
    if (open) returnFocusRef.current = document.activeElement as HTMLElement | null
  }, [open])

  const hidden = mobile ? { y: '100%' } : { x: '100%' }
  const shown = mobile ? { y: 0 } : { x: 0 }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen} modal={mobile}>
      {showTrigger ? (
        <DialogPrimitive.Trigger asChild>
          <Button
            type="button"
            leadingIcon={MessageCircle}
            data-embedded-chat-trigger=""
            // 打开时隐藏但保留：Radix 关闭后把焦点还给它
            className={cn(
              'fixed right-4 bottom-6 z-(--z-sticky) h-11 rounded-full pr-4 pl-3.5 shadow-surface-5 before:rounded-full',
              'print:hidden',
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
                onOpenAutoFocus={(event) => {
                  // 焦点落到面板本身，而不是第一个推荐问题（看起来像被选中）
                  event.preventDefault()
                  panelRef.current?.focus()
                }}
                onCloseAutoFocus={(event) => {
                  const target = returnFocusRef.current
                  returnFocusRef.current = null
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
                      ? 'inset-x-0 bottom-0 max-h-[85dvh] rounded-t-2xl'
                      : 'top-2 right-2 bottom-2 w-[min(25rem,calc(100vw-1rem))] rounded-xl',
                    surfaceClasses(level, 5),
                    className,
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
  )
}

export type { EmbeddedChatLabels, EmbeddedChatProps }
export { EmbeddedChat }
