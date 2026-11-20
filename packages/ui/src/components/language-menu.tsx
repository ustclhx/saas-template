// 模板新增（openspec multilingual-seo 4.3，设计稿 docs/design-system/prototypes/multilingual-seo/Switcher）：
// 语言切换菜单。触发器外观沿用 SelectTrigger，菜单项是普通 <a href hreflang>，选择即整页跳转。

import { Check } from 'lucide-react'
import type { MouseEvent } from 'react'
import type { IconComponentProps } from '../lib/icon-context.tsx'
import { triggerVariants } from '../lib/select-trigger.ts'
import { useShape } from '../lib/shape-context.tsx'
import { useSize } from '../lib/size-context.tsx'
import { cn } from '../lib/utils.ts'
import { DropdownContent, DropdownMenu, DropdownTrigger, MenuItem } from './dropdown.tsx'

export interface LanguageMenuItem {
  /** 语言 id，同时作为链接的 hreflang 与文字的 lang */
  locale: string
  /** 该语言的自称（如「中文」「English」） */
  label: string
  /** 该语言版本的地址：公开页取本页 hreflang 声明的地址，没有该语言版本时不列出 */
  href: string
  /** 当前页的语言：带 aria-current="page" 与勾选标记 */
  current?: boolean
}

export interface LanguageMenuProps {
  /** 触发器的可读名称（如「语言」） */
  label: string
  items: readonly LanguageMenuItem[]
  /** 水合前禁用：菜单在客户端才能展开（菜单项本身是普通链接） */
  disabled?: boolean
  /** 菜单展开方向，默认向上（浮动控件与页脚设置行都贴近视口底部） */
  side?: 'top' | 'bottom'
  className?: string
  /** 点击某一项时回调（键盘激活同样触发）；不调用 preventDefault 时由链接自行跳转 */
  onItemClick?: (item: LanguageMenuItem, event: MouseEvent<HTMLElement>) => void
}

/** 非当前项的图标占位：与勾选图标同宽，各行文字对齐 */
function Blank({ size = 16 }: IconComponentProps) {
  return <span aria-hidden="true" className="inline-block" style={{ width: size, height: size }} />
}

/**
 * 语言切换器：Dropdown 菜单，每项是指向该语言版本的普通链接（链接图检查只计 `<a href>`）。
 * 触发器显示当前语言（服务端输出即可见），水合前可传 `disabled`。手机上菜单行高 44px。
 */
export function LanguageMenu({
  label,
  items,
  disabled = false,
  side = 'top',
  className,
  onItemClick,
}: LanguageMenuProps) {
  const shape = useShape()
  const size = useSize()
  const current = items.find((item) => item.current)
  return (
    <DropdownMenu disabled={disabled}>
      <DropdownTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            className={cn(
              triggerVariants({ variant: 'bordered' }),
              size.control,
              size.text,
              size.px,
              size.gap,
              shape.input,
              'min-w-0 max-w-full',
              className,
            )}
          >
            <span
              lang={current?.locale}
              className="min-w-0 flex-1 truncate py-1 -my-1 text-left [text-box:trim-both_cap_alphabetic]"
            >
              {current?.label ?? label}
            </span>
            <svg
              aria-hidden="true"
              width={size.icon}
              height={size.icon}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-muted-foreground transition-colors duration-80 group-hover:text-foreground"
            >
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        }
      />
      <DropdownContent side={side} align="start" className="w-60">
        {items.map((item, index) => (
          <MenuItem
            key={item.locale}
            index={index}
            label={item.label}
            icon={item.current ? Check : Blank}
            className="max-md:h-11"
            onClick={onItemClick ? (event) => onItemClick(item, event) : undefined}
            render={
              <a
                href={item.href}
                hrefLang={item.locale}
                lang={item.locale}
                aria-current={item.current ? 'page' : undefined}
              />
            }
          />
        ))}
      </DropdownContent>
    </DropdownMenu>
  )
}
