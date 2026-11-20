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
      // 转化入口：不计入正文链接，指向应用区不算「正文链接到不可索引页」
      data-link-zone="action"
      // 右下浮动组的成员：app.css 据此计算 --floating-stack-height，语言提示条叠在它上方
      data-ai-entry={inline ? undefined : ''}
      aria-label={m.marketing_ai_entry_label()}
      className={cn(
        'inline-flex h-12 items-center gap-2 rounded-full bg-primary pr-4.5 pl-4 font-medium text-body text-primary-foreground shadow-surface-5',
        'transition-colors hover:bg-primary/90 motion-reduce:transition-none',
        'outline-none focus-visible:outline-2 focus-visible:outline-(--focus-ring) focus-visible:outline-offset-2 focus-visible:outline-solid',
        // md 及以上根布局右下角有浮动主题切换（right-4 bottom-4，高 42px），入口叠在它上方；
        // 手机端主题切换移到页脚设置行，入口贴底（设计稿 mobile-footer-controls）
        inline ? 'w-fit' : 'fixed right-4 bottom-4 z-(--z-sticky) md:bottom-18',
      )}
    >
      <Sparkles aria-hidden="true" className="size-4.5" strokeWidth={1.75} />
      {m.marketing_ai_entry()}
    </ConfigLink>
  )
}
