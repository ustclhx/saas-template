import { cn } from '@saas/ui'
import { Sparkles } from '@saas/ui/icons'
import { m } from '../../paraglide/messages.js'
import { ConfigLink } from './config-link.tsx'

/**
 * 悬浮 AI 入口（openspec add-ui-design-system 8.5，marketing-site「悬浮 AI 入口」）：营销页右下角固定，
 * 点击跳转配置的地址，不内嵌对话。页脚为它留出底部空白（SiteFooter 的 floatingEntry），滚到底时不遮挡页脚链接。
 * `inline` 用于 /dev/ui 预览，按普通流式元素排布。
 */
export function AiEntry({ href, inline = false }: { href: string; inline?: boolean }) {
  return (
    <ConfigLink
      href={href}
      aria-label={m.marketing_ai_entry_label()}
      className={cn(
        'inline-flex h-12 items-center gap-2 rounded-full bg-primary pr-4.5 pl-4 font-medium text-body text-primary-foreground shadow-surface-5',
        'transition-colors hover:bg-primary/90 motion-reduce:transition-none',
        'outline-none focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:outline-offset-2 focus-visible:outline-solid',
        // 根布局在营销页右下角已有浮动主题切换（right-4 bottom-4，高 42px），入口叠在它上方并右对齐
        inline ? 'w-fit' : 'fixed right-4 bottom-18 z-(--z-sticky)',
      )}
    >
      <Sparkles aria-hidden="true" className="size-4.5" strokeWidth={1.75} />
      {m.marketing_ai_entry()}
    </ConfigLink>
  )
}
