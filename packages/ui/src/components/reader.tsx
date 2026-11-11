// 来源：无（模板新增，openspec add-ui-design-system tasks 8.4，design D11）。
// 长文阅读器：安全 Markdown（react-markdown + remark-gfm，丢弃原始 HTML、元素白名单、链接协议白名单）、
// 自动目录（h2 / h3）、吸顶目录与当前节高亮、顶部阅读进度、移动端目录下拉、打印样式与导出 PDF。
// 外观与各状态按 docs/design-system/prototypes/ui-review/Reader.dc.html、ReaderMobile.dc.html。
// 组件内没有默认文案，全部经 `labels` 与各插槽由调用方按语言传入。
import { BookOpen, Download, List, RotateCw } from 'lucide-react'
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useIcons } from '../lib/icon-context.tsx'
import {
  extractHeadings,
  isExternalUrl,
  MARKDOWN_ALLOWED_ELEMENTS,
  type ReaderHeading,
  rehypeHeadingIds,
  safeMarkdownUrl,
} from '../lib/markdown.ts'
import { cn } from '../lib/utils.ts'
import { Alert, AlertDescription, AlertTitle } from './alert.tsx'
import { Button } from './button.tsx'
import { DropdownContent, DropdownMenu, DropdownTrigger } from './dropdown.tsx'
import { MenuItem } from './menu-item.tsx'
import { usePdfExporter } from './pdf-exporter.ts'

export type ReaderStatus = 'ready' | 'loading' | 'empty' | 'error'

export interface ReaderLabels {
  /** 目录标题，兼作目录导航的可读名称 */
  readonly toc: string
  /** 阅读进度条的可读名称 */
  readonly progress: string
  /** 导出按钮文字（窄屏只显示图标时作为可读名称） */
  readonly exportPdf: string
  /** 注册了服务端导出后，菜单中「浏览器打印」一项 */
  readonly printPdf: string
  /** 注册了服务端导出后，菜单中「服务端生成 PDF」一项 */
  readonly serverPdf: string
  /** 加载中，供读屏播报 */
  readonly loading: string
}

export interface ReaderProps extends Omit<ComponentProps<'div'>, 'title' | 'children'> {
  /** 文档标题：显示在顶栏与正文开头，也传给服务端导出 */
  readonly title: string
  /** Markdown 源文；只在 `status="ready"` 时渲染 */
  readonly markdown?: string
  readonly status?: ReaderStatus
  readonly labels: ReaderLabels
  /** 顶栏标题前的内容：宽屏放面包屑，窄屏放返回按钮 */
  readonly leading?: ReactNode
  /** 顶栏导出按钮后的操作（通知、明暗切换等） */
  readonly actions?: ReactNode
  /** 标题下方的说明行（来源、日期、阅读时长、标签等） */
  readonly meta?: ReactNode
  /** `status="empty"` 时显示，通常为 `ReaderEmpty` */
  readonly emptyState?: ReactNode
  /** `status="error"` 时显示，通常为 `ReaderError` */
  readonly errorState?: ReactNode
  /** 正文之后的插槽（如嵌入式对话、悬浮提问入口）；打印时隐藏 */
  readonly footer?: ReactNode
  /** 服务端导出失败时调用；未传时错误只在控制台输出 */
  readonly onPdfExportError?: (error: unknown) => void
}

/** 顶栏与移动端目录条之下再留出的距离：标题越过这条线即视为进入该节 */
const ACTIVE_OFFSET = 32
const USER_SCROLL_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '])

/** 最近的纵向滚动容器；页面本身滚动时返回 null（工作台主面板等容器内滚动时用它的下沿代替视口下沿） */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement
  while (node && node !== node.ownerDocument.body && node !== node.ownerDocument.documentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node
    }
    node = node.parentElement
  }
  return null
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false
}

/**
 * 跟随滚动计算阅读进度与当前节。监听捕获阶段的 scroll，页面滚动与外层滚动容器（如工作台主面板）都能收到；
 * 点击目录后锁定高亮到所选标题，直到读者自己滚动（滚轮、触摸、按键），避免平滑滚动途经的标题闪烁，
 * 也避免文末几节无法滚到顶部时高亮落回上一节。
 */
function useReadingPosition(
  enabled: boolean,
  headings: readonly ReaderHeading[],
  articleRef: React.RefObject<HTMLElement | null>,
  barRef: React.RefObject<HTMLElement | null>,
) {
  const [progress, setProgress] = useState(0)
  const [activeId, setActiveId] = useState<string | null>(headings[0]?.id ?? null)
  const lockedRef = useRef<string | null>(null)
  const scrollParentRef = useRef<HTMLElement | null>(null)

  const measure = useCallback(() => {
    const article = articleRef.current
    if (!enabled || !article) {
      setProgress(0)
      return
    }
    const container = scrollParentRef.current
    const viewport = container
      ? Math.min(container.getBoundingClientRect().bottom, window.innerHeight)
      : window.innerHeight
    const top = (barRef.current?.getBoundingClientRect().bottom ?? 0) + ACTIVE_OFFSET
    const rect = article.getBoundingClientRect()
    const scrollable = rect.height - (viewport - top)
    const value =
      scrollable <= 0
        ? rect.top < viewport
          ? 100
          : 0
        : Math.round(Math.min(Math.max((top - rect.top) / scrollable, 0), 1) * 100)
    setProgress(value)
    if (lockedRef.current || headings.length === 0) return
    let current = headings[0]?.id ?? null
    // 已滚到正文末尾时高亮最后一节（文末几节可能无法滚到顶栏下方）
    if (scrollable > 0 && top - rect.top >= scrollable - 1) {
      current = headings[headings.length - 1]?.id ?? current
    } else {
      for (const heading of headings) {
        const el = article.ownerDocument.getElementById(heading.id)
        if (el && el.getBoundingClientRect().top <= top) current = heading.id
      }
    }
    setActiveId(current)
  }, [enabled, headings, articleRef, barRef])

  useEffect(() => {
    setActiveId(headings[0]?.id ?? null)
    lockedRef.current = null
  }, [headings])

  useEffect(() => {
    if (!enabled) {
      setProgress(0)
      return
    }
    let frame = 0
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }
    const release = (event: Event) => {
      if (event instanceof KeyboardEvent && !USER_SCROLL_KEYS.has(event.key)) return
      if (lockedRef.current) {
        lockedRef.current = null
        schedule()
      }
    }
    scrollParentRef.current = articleRef.current ? findScrollParent(articleRef.current) : null
    measure()
    window.addEventListener('scroll', schedule, { capture: true, passive: true })
    window.addEventListener('resize', schedule)
    window.addEventListener('wheel', release, { passive: true })
    window.addEventListener('touchstart', release, { passive: true })
    window.addEventListener('keydown', release)
    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', schedule, { capture: true })
      window.removeEventListener('resize', schedule)
      window.removeEventListener('wheel', release)
      window.removeEventListener('touchstart', release)
      window.removeEventListener('keydown', release)
    }
  }, [enabled, measure, articleRef])

  const jumpTo = useCallback(
    (id: string) => {
      const target = articleRef.current?.ownerDocument.getElementById(id)
      if (!target) return
      lockedRef.current = id
      setActiveId(id)
      target.scrollIntoView({
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        block: 'start',
      })
      target.focus({ preventScroll: true })
      window.history.replaceState(window.history.state, '', `#${encodeURIComponent(id)}`)
    },
    [articleRef],
  )

  return { progress, activeId, jumpTo }
}

/**
 * 打印时临时切到浅色：深色主题的浅色文字打在白纸上不可读。只在阅读器挂载期间监听，打印结束后还原。
 */
function usePrintInLightMode() {
  useEffect(() => {
    const root = document.documentElement
    let restore = false
    const before = () => {
      restore = root.classList.contains('dark')
      if (restore) root.classList.remove('dark')
    }
    const after = () => {
      if (restore) root.classList.add('dark')
      restore = false
    }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      after()
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [])
}

// 正文排版：桌面与移动两档取自画板的 .md 样式；h2 打印时从新页开始（第一节紧跟标题不分页）
const markdownComponents: Components = {
  h1: ({ node: _node, className, ...props }) => (
    <h2
      className={cn(
        'mt-7 mb-2 scroll-mt-32 font-semibold text-lg/6.5 tracking-[-0.005em] outline-none md:mt-10 md:mb-3 md:text-xl/7 lg:scroll-mt-20 print:break-after-avoid',
        className,
      )}
      {...props}
    />
  ),
  h2: ({ node: _node, className, ...props }) => (
    <h2
      tabIndex={-1}
      className={cn(
        'mt-7 mb-2 scroll-mt-32 font-semibold text-lg/6.5 tracking-[-0.005em] outline-none md:mt-10 md:mb-3 md:text-xl/7 lg:scroll-mt-20 print:break-after-avoid print:[&:not(:first-of-type)]:break-before-page',
        className,
      )}
      {...props}
    />
  ),
  h3: ({ node: _node, className, ...props }) => (
    <h3
      tabIndex={-1}
      className={cn(
        'mt-5 mb-1.5 scroll-mt-32 font-semibold text-title outline-none md:mt-7 md:mb-2 lg:scroll-mt-20 print:break-after-avoid',
        className,
      )}
      {...props}
    />
  ),
  h4: ({ node: _node, className, ...props }) => (
    <h4 className={cn('mt-5 mb-1.5 font-semibold text-subtitle', className)} {...props} />
  ),
  h5: ({ node: _node, className, ...props }) => (
    <h5 className={cn('mt-4 mb-1 font-semibold text-subtitle', className)} {...props} />
  ),
  h6: ({ node: _node, className, ...props }) => (
    <h6
      className={cn('mt-4 mb-1 font-semibold text-muted-foreground text-subtitle', className)}
      {...props}
    />
  ),
  p: ({ node: _node, className, ...props }) => (
    <p className={cn('mb-3 md:mb-3.5', className)} {...props} />
  ),
  ul: ({ node: _node, className, ...props }) => (
    <ul
      className={cn(
        'mb-3 list-disc pl-5 md:mb-3.5 md:pl-5.5 [&_ol]:mb-0 [&_ul]:mb-0 [&_ul]:list-[circle]',
        className,
      )}
      {...props}
    />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol
      className={cn(
        'mb-3 list-decimal pl-5 md:mb-3.5 md:pl-5.5 [&_ol]:mb-0 [&_ul]:mb-0',
        className,
      )}
      {...props}
    />
  ),
  li: ({ node: _node, className, ...props }) => (
    <li className={cn('my-1 [&>input]:mr-2 [&>input]:align-middle', className)} {...props} />
  ),
  blockquote: ({ node: _node, className, ...props }) => (
    <blockquote
      className={cn(
        'mb-3 border-border border-l-2 py-0.5 pl-3.5 text-muted-foreground md:mb-3.5 md:pl-4 [&>p:last-child]:mb-0 print:break-inside-avoid',
        className,
      )}
      {...props}
    />
  ),
  pre: ({ node: _node, className, ...props }) => (
    <pre
      className={cn(
        'mb-4 overflow-x-auto rounded-lg bg-muted px-4 py-3.5 font-mono text-caption leading-[18px] inset-ring-1 inset-ring-border [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 print:whitespace-pre-wrap print:break-inside-avoid',
        className,
      )}
      {...props}
    />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code
      className={cn('rounded-sm bg-active px-1.25 py-px font-mono text-caption', className)}
      {...props}
    />
  ),
  a: ({ node: _node, href, className, children, ...props }) => {
    // 协议不在白名单内时 urlTransform 返回空串：渲染为纯文本，不留下可点击的空链接
    if (!href) return <span className={className}>{children}</span>
    const external = isExternalUrl(href)
    return (
      <a
        href={href}
        className={cn(
          'text-primary-text underline underline-offset-4 hover:decoration-2 focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:outline-offset-2',
          className,
        )}
        {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
        {...props}
      >
        {children}
      </a>
    )
  },
  img: ({ node: _node, src, alt, className, ...props }) =>
    src ? (
      <img
        src={src}
        alt={alt ?? ''}
        loading="lazy"
        referrerPolicy="no-referrer"
        className={cn('my-2 h-auto max-w-full rounded-lg', className)}
        {...props}
      />
    ) : alt ? (
      <span className={className}>{alt}</span>
    ) : null,
  hr: ({ node: _node, className, ...props }) => (
    <hr className={cn('my-8 border-border', className)} {...props} />
  ),
  // 窄屏下表格在自身容器内横向滚动，页面不出现横向滚动
  table: ({ node: _node, className, ...props }) => (
    <div className="mb-4 overflow-x-auto rounded-md border border-border print:overflow-visible">
      <table className={cn('w-full border-collapse text-body', className)} {...props} />
    </div>
  ),
  thead: ({ node: _node, className, ...props }) => (
    <thead className={cn('bg-muted/50', className)} {...props} />
  ),
  tr: ({ node: _node, className, ...props }) => (
    <tr
      className={cn('border-border border-b last:border-b-0 print:break-inside-avoid', className)}
      {...props}
    />
  ),
  th: ({ node: _node, className, ...props }) => (
    <th
      className={cn(
        'whitespace-nowrap px-3 py-2 text-left font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  ),
  td: ({ node: _node, className, ...props }) => (
    <td className={cn('px-3 py-2 tabular-nums', className)} {...props} />
  ),
}

function ReaderMarkdown({
  markdown,
  headings,
}: {
  readonly markdown: string
  readonly headings: readonly ReaderHeading[]
}) {
  const rehypePlugins = useMemo(() => [rehypeHeadingIds(headings)], [headings])
  return (
    <Markdown
      skipHtml
      allowedElements={MARKDOWN_ALLOWED_ELEMENTS}
      unwrapDisallowed
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins}
      urlTransform={safeMarkdownUrl}
      components={markdownComponents}
    >
      {markdown}
    </Markdown>
  )
}

function ExportControl({
  labels,
  disabled,
  title,
  markdown,
  onError,
}: {
  readonly labels: ReaderLabels
  readonly disabled: boolean
  readonly title: string
  readonly markdown: string
  readonly onError: ((error: unknown) => void) | undefined
}) {
  const exporter = usePdfExporter()
  const [busy, setBusy] = useState(false)
  // 窄屏只显示图标（画板 ReaderMobile 为无边框图标按钮），宽屏为带文字的描边按钮
  const button = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      leadingIcon={Download}
      loading={busy}
      disabled={disabled}
      aria-label={labels.exportPdf}
      className="max-md:size-9 max-md:before:ring-0"
      {...(exporter ? {} : { onClick: () => window.print() })}
    >
      <span className="max-md:sr-only">{labels.exportPdf}</span>
    </Button>
  )
  if (!exporter || disabled) return button

  async function exportOnServer(run: NonNullable<typeof exporter>) {
    setBusy(true)
    try {
      await run({ title, markdown })
    } catch (error) {
      if (onError) onError(error)
      else console.error(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownTrigger render={button} />
      <DropdownContent align="end">
        <MenuItem index={0} label={labels.printPdf} onSelect={() => window.print()} />
        <MenuItem index={1} label={labels.serverPdf} onSelect={() => exportOnServer(exporter)} />
      </DropdownContent>
    </DropdownMenu>
  )
}

function MobileToc({
  labels,
  headings,
  activeId,
  onPick,
}: {
  readonly labels: ReaderLabels
  readonly headings: readonly ReaderHeading[]
  readonly activeId: string | null
  readonly onPick: (id: string) => void
}) {
  const icons = useIcons()
  const Chevron = icons['chevron-down']
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const current = headings.find((heading) => heading.id === activeId) ?? headings[0]

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div
      ref={containerRef}
      data-slot="reader-mobile-toc"
      className="relative border-border border-b px-4 py-2 lg:hidden"
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-body inset-ring-1 inset-ring-border outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:outline-offset-2"
      >
        <List aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-caption text-muted-foreground">{labels.toc}</span>
        <span className="min-w-0 flex-1 truncate text-left font-medium">{current?.text}</span>
        <Chevron
          size={16}
          className={cn(
            'shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none',
            open && 'rotate-180',
          )}
        />
      </button>
      {open ? (
        <nav
          id={panelId}
          aria-label={labels.toc}
          className="absolute inset-x-4 top-12 z-(--z-popover) max-h-[60vh] overflow-y-auto rounded-xl bg-popover py-1 text-popover-foreground shadow-surface-4"
        >
          {headings.map((heading) => {
            const active = heading.id === current?.id
            return (
              <a
                key={heading.id}
                href={`#${heading.id}`}
                aria-current={active ? 'location' : undefined}
                onClick={(event) => {
                  event.preventDefault()
                  setOpen(false)
                  onPick(heading.id)
                }}
                className={cn(
                  'block px-4 py-2.5 text-body outline-none hover:bg-hover focus-visible:bg-hover',
                  heading.level === 3 && 'pl-8',
                  active ? 'bg-active font-medium text-foreground' : 'text-muted-foreground',
                )}
              >
                {heading.text}
              </a>
            )
          })}
        </nav>
      ) : null}
    </div>
  )
}

function Skeleton({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'block animate-pulse rounded-md bg-active motion-reduce:animate-none',
        className,
      )}
    />
  )
}

const SKELETON_LINES = [
  'w-full',
  'w-11/12',
  'w-5/6',
  'w-full',
  'w-3/4',
  'w-11/12',
  'w-full',
  'w-5/6',
  'w-3/5',
  'w-full',
  'w-11/12',
  'w-2/3',
]

/**
 * 长文阅读器。放在可滚动的页面或容器中：顶栏（标题、导出、阅读进度）与移动端目录条吸顶，
 * 宽屏左侧为吸顶目录。正文中的原始 HTML 一律丢弃，链接只允许 http、https 与站内地址。
 * 打印时隐藏顶栏、目录与 `footer` 插槽，二级标题从新页开始，深色主题临时切为浅色。
 */
export function Reader({
  title,
  markdown = '',
  status = 'ready',
  labels,
  leading,
  actions,
  meta,
  emptyState,
  errorState,
  footer,
  onPdfExportError,
  className,
  ...props
}: ReaderProps) {
  const ready = status === 'ready'
  const headings = useMemo(() => (ready ? extractHeadings(markdown) : []), [ready, markdown])
  const articleRef = useRef<HTMLElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const { progress, activeId, jumpTo } = useReadingPosition(ready, headings, articleRef, barRef)
  usePrintInLightMode()

  return (
    <div
      data-slot="reader"
      data-status={status}
      className={cn(
        'flex min-h-full flex-col bg-surface-2 text-body text-foreground print:bg-transparent',
        className,
      )}
      {...props}
    >
      <div
        ref={barRef}
        data-slot="reader-bar"
        className="sticky top-0 z-(--z-sticky) bg-surface-2 print:hidden"
      >
        <header className="relative flex h-14 items-center gap-1 border-border border-b px-2 md:gap-2 md:pr-4 md:pl-6">
          <div className="flex min-w-0 flex-1 items-center gap-1 md:gap-1.5">
            {leading}
            <p className="min-w-0 truncate font-semibold text-title">{title}</p>
          </div>
          <ExportControl
            labels={labels}
            disabled={!ready}
            title={title}
            markdown={markdown}
            onError={onPdfExportError}
          />
          {actions}
          <div
            role="progressbar"
            aria-label={labels.progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            className="absolute inset-x-0 -bottom-px h-0.5"
          >
            <div
              className="h-full rounded-r-xs bg-primary transition-[width] duration-100 motion-reduce:transition-none"
              style={{ width: `${progress}%` }}
            />
          </div>
        </header>
        {ready && headings.length > 0 ? (
          <MobileToc labels={labels} headings={headings} activeId={activeId} onPick={jumpTo} />
        ) : null}
      </div>

      <div className="mx-auto grid w-full max-w-[66rem] items-start gap-12 px-4 pt-5 pb-24 lg:grid-cols-[13rem_minmax(0,1fr)] lg:px-8 lg:pt-8 lg:pb-16 print:block print:max-w-none print:p-0">
        <nav
          aria-label={labels.toc}
          data-slot="reader-toc"
          className="sticky top-20 hidden max-h-[calc(100vh-7rem)] flex-col gap-0.5 overflow-y-auto border-border border-l lg:flex print:hidden"
        >
          <span className="px-3 pb-1.5 font-medium text-caption text-muted-foreground">
            {labels.toc}
          </span>
          {status === 'loading' ? (
            <span className="flex flex-col gap-3 px-3 py-1.5">
              <Skeleton className="h-2.5 w-[70%]" />
              <Skeleton className="h-2.5 w-[85%]" />
              <Skeleton className="h-2.5 w-3/5" />
            </span>
          ) : null}
          {headings.map((heading) => {
            const active = heading.id === activeId
            return (
              <a
                key={heading.id}
                href={`#${heading.id}`}
                aria-current={active ? 'location' : undefined}
                onClick={(event) => {
                  event.preventDefault()
                  jumpTo(heading.id)
                }}
                className={cn(
                  '-ml-px block border-l-2 py-1 pr-3 text-body outline-none transition-colors duration-100 hover:text-foreground focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:-outline-offset-2',
                  heading.level === 3 ? 'pl-6' : 'pl-3',
                  active
                    ? 'border-primary font-medium text-foreground'
                    : 'border-transparent text-muted-foreground',
                )}
              >
                {heading.text}
              </a>
            )
          })}
        </nav>

        <div className="flex min-w-0 flex-col gap-10">
          {status === 'loading' ? (
            <div aria-busy="true" className="flex max-w-[45rem] flex-col gap-3 md:gap-3.5">
              <span className="sr-only" role="status">
                {labels.loading}
              </span>
              <Skeleton className="h-6.5 w-4/5 md:h-7.5 md:w-3/5" />
              <Skeleton className="h-3 w-1/2 md:w-2/5" />
              <span className="h-3 md:h-4" />
              {SKELETON_LINES.map((width, index) => (
                <Skeleton
                  // biome-ignore lint/suspicious/noArrayIndexKey: 固定长度的占位行，无身份
                  key={index}
                  className={cn('h-3', width, index >= 10 && 'max-md:hidden')}
                />
              ))}
            </div>
          ) : null}
          {status === 'empty' ? emptyState : null}
          {status === 'error' ? errorState : null}
          {ready ? (
            <article
              ref={articleRef}
              data-slot="reader-article"
              className="max-w-[45rem] text-body leading-6 print:max-w-none"
            >
              <header className="mb-2 flex flex-col gap-1.5 md:gap-2">
                <h1 className="m-0 font-semibold text-(length:--fs-display-compact) leading-(--lh-display-compact) tracking-[-0.01em] md:text-display">
                  {title}
                </h1>
                {meta ? (
                  <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                    {meta}
                  </div>
                ) : null}
              </header>
              <ReaderMarkdown markdown={markdown} headings={headings} />
            </article>
          ) : null}
          {ready && footer ? (
            <div data-slot="reader-footer" className="max-w-[45rem] print:hidden">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export interface ReaderEmptyProps {
  readonly title: string
  readonly description?: string
  /** 主操作，如「生成报告」按钮 */
  readonly action?: ReactNode
}

/** 阅读器空状态：虚线框图示、标题、说明与主操作 */
export function ReaderEmpty({ title, description, action }: ReaderEmptyProps) {
  return (
    <div className="flex max-w-[45rem] flex-col items-center gap-2.5 px-4 pt-24 text-center md:pb-24">
      <div
        aria-hidden="true"
        className="flex h-19 w-26 items-center justify-center rounded-xl border border-border border-dashed text-muted-foreground md:h-22 md:w-30"
      >
        <BookOpen className="size-6" strokeWidth={1.5} />
      </div>
      <h2 className="mt-1 font-semibold text-title">{title}</h2>
      {description ? <p className="max-w-sm text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  )
}

export interface ReaderErrorProps {
  readonly title: string
  readonly description?: string
  /** 传入时显示重试按钮 */
  readonly retryLabel?: string
  readonly onRetry?: () => void
}

/** 阅读器错误状态：说明正文暂时无法读取，并提供重试 */
export function ReaderError({ title, description, retryLabel, onRetry }: ReaderErrorProps) {
  const icons = useIcons()
  const AlertIcon = icons['circle-alert']
  return (
    <Alert variant="destructive" className="max-w-[45rem]">
      <AlertIcon size={16} />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="gap-2.5 text-destructive">
        {description ? <p>{description}</p> : null}
        {retryLabel && onRetry ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            leadingIcon={RotateCw}
            onClick={onRetry}
          >
            {retryLabel}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  )
}
