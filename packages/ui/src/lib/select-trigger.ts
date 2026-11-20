// 模板改动（multilingual-seo 4.3）：SelectTrigger 的外观从 select.tsx 拆出，LanguageMenu 的触发器复用同一套样式，
// 而不必把整个 Select（Radix Select 与弹层）带进首页包。
import { cva } from 'class-variance-authority'

export const triggerVariants = cva(
  [
    'group inline-flex items-center justify-between outline-none cursor-pointer',
    // Listed, never `all`: a size change snaps instead of easing the
    // trigger's height and padding.
    'transition-[color,background-color,border-radius,box-shadow,opacity] duration-80',
    'disabled:opacity-50 disabled:pointer-events-none',
    // data-pointer-focus: focus handed back after a pick with the pointer.
    // 模板改动：焦点环改为 2px 描边加 2px 间隙（与 Button 一致），上游为 1px ring
    'focus-visible:not-data-[pointer-focus]:outline-solid focus-visible:not-data-[pointer-focus]:outline-2 focus-visible:not-data-[pointer-focus]:outline-offset-2 focus-visible:not-data-[pointer-focus]:outline-(--focus-ring)',
  ],
  {
    variants: {
      variant: {
        // 模板改动：边框取 --field-border（与 Input、Textarea 共用，默认等于 --border）
        bordered: 'border border-field-border bg-transparent text-foreground hover:bg-hover',
        borderless: 'border border-transparent bg-transparent text-foreground hover:bg-hover',
      },
    },
    defaultVariants: {
      variant: 'bordered',
    },
  },
)
