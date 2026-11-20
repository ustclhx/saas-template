// 模板新增（openspec multilingual-seo 4.2，设计稿 docs/design-system/prototypes/multilingual-seo/）：语言提示条。
// 纯展示：目标地址、语言与文案由调用方传入，何时挂载、候选语言与关闭记录由应用决定（apps/web）。

import { ArrowRight, Languages, X } from 'lucide-react'
import { type AnimationEvent, useEffect, useRef, useState } from 'react'
import { cn } from '../lib/utils.ts'
import { Button } from './button.tsx'

export interface LanguagePromptLabels {
  /** 区域的可读名称（如「语言建议」），用建议语言书写 */
  region: string
  /** 一句话提示（如「本页有中文版本」），用建议语言书写 */
  message: string
  /** 链接文字（如「查看中文版」） */
  action: string
  /** 关闭按钮的可读名称（如「关闭语言提示」） */
  close: string
}

export interface LanguagePromptProps {
  /** 目标语言版本的地址：取本页 hreflang 中对应语言的地址，普通链接整页跳转 */
  href: string
  /** 链接的 hreflang 与容器的 lang：建议的语言 */
  hrefLang: string
  /** 容器的 lang，省略时同 hrefLang */
  lang?: string
  /** 建议语言的书写方向；rtl 时整体镜像、箭头翻转 */
  dir?: 'ltr' | 'rtl'
  labels: LanguagePromptLabels
  /** 关闭：退出动画结束后回调，调用方据此记下关闭并卸载组件 */
  onDismiss: () => void
  /** 点击链接时回调（不阻止跳转），供调用方记下选择 */
  onFollow?: () => void
  /** 在正文流中排布（/dev/ui 预览），不固定定位、不播放进入动画 */
  inline?: boolean
  className?: string
}

/** 退出动画（float-exit 120ms）的兜底卸载时长：后台标签页可能不播放动画，animationend 不会触发 */
const EXIT_FALLBACK_MS = 200

/**
 * 语言提示条：固定在右下浮动组（主题切换、Ask AI）上方，不占文档流、不引起版面位移。
 * - 桌面宽 360px 贴右；手机左右 12px。底部距离取 `--floating-stack-height`（右下浮动组的总高度，由应用按实际控件设置）
 *   再加 12px 间隙，没有浮动组时贴底（含 safe-area）。
 * - 进入 160ms（淡入并上移 8px）、退出 120ms，`prefers-reduced-motion: reduce` 时只淡入淡出；纯 CSS，不加载 motion。
 * - 不抢焦点、不是实时播报区域，Esc 不处理（非对话框）。带 `data-language-prompt`，链接图检查据此断言它不在服务端 HTML 中。
 */
export function LanguagePrompt({
  href,
  hrefLang,
  lang,
  dir = 'ltr',
  labels,
  onDismiss,
  onFollow,
  inline = false,
  className,
}: LanguagePromptProps) {
  const [leaving, setLeaving] = useState(false)
  const dismissed = useRef(false)
  const finish = () => {
    if (dismissed.current) return
    dismissed.current = true
    onDismiss()
  }
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(finish, EXIT_FALLBACK_MS)
    return () => clearTimeout(timer)
  })
  const onAnimationEnd = (event: AnimationEvent<HTMLElement>) => {
    if (leaving && event.target === event.currentTarget) finish()
  }

  return (
    <aside
      lang={lang ?? hrefLang}
      dir={dir}
      aria-label={labels.region}
      data-language-prompt=""
      data-link-zone="nav"
      onAnimationEnd={onAnimationEnd}
      className={cn(
        'flex items-start gap-2.5 rounded-xl bg-surface-5 pt-3 text-body text-foreground shadow-surface-5 print:hidden',
        // 手机：左右 12px，关闭按钮扩到 44px 触控区，右侧内边距收为 4px；桌面 360px、右侧 8px
        'ps-3.5 pe-1 pb-3 md:pe-2 md:pb-3.5',
        inline
          ? 'w-full max-w-90'
          : 'fixed inset-x-3 bottom-[calc(var(--floating-stack-height,0px)+0.75rem+env(safe-area-inset-bottom))] z-(--z-sticky) md:inset-x-auto md:right-4 md:w-90',
        !inline &&
          (leaving
            ? 'animate-float-exit motion-reduce:animate-float-fade-out'
            : 'animate-float-enter motion-reduce:animate-float-fade-in'),
        className,
      )}
    >
      <Languages
        aria-hidden="true"
        size={16}
        strokeWidth={1.75}
        className="mt-0.5 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <p className="m-0 font-medium">{labels.message}</p>
        {/* 箭头包一层 span：Button 的 has-[>svg] 内边距规则不生效，左右内边距按设计稿 12 / 10px（手机 16 / 14px） */}
        <Button
          asChild
          size="sm"
          className="self-start pe-2.5 max-md:h-10 max-md:gap-2 max-md:ps-4 max-md:pe-3.5"
        >
          <a href={href} hrefLang={hrefLang} onClick={onFollow}>
            {labels.action}
            <span aria-hidden="true" className="inline-flex">
              <ArrowRight strokeWidth={1.75} className="size-3.5 rtl:-scale-x-100 max-md:size-4" />
            </span>
          </a>
        </Button>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={labels.close}
        disabled={leaving}
        onClick={() => {
          if (inline) finish()
          else setLeaving(true)
        }}
        className="max-md:-mt-2.5 max-md:size-11"
      >
        <X aria-hidden="true" strokeWidth={1.75} className="size-4 max-md:size-4.5" />
      </Button>
    </aside>
  )
}
