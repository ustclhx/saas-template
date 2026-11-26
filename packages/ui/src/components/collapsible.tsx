// 来源：shadcn/ui collapsible（new-york-v4，2026-11，https://ui.shadcn.com/r/styles/new-york-v4/collapsible.json，MIT）补缺：
// Fluid 没有独立的 Collapsible（只有 accordion）。结构与 API 取 shadcn（Radix Collapsible：Root / Trigger / Content）；
// 其余改动见 packages/ui/UPSTREAM.md
// 模板改动（openspec add-media-studio，创作页「更多设置」折叠区，设计稿 docs/design-system/prototypes/media-studio/Main.dc.html）：
// - 未用 asChild 的触发按钮补统一焦点环（2px 描边加 2px 间隙），上游无样式；
// - 内容区用 tw-animate-css 的 collapsible-down / up 关键帧按 Radix 测得的高度展开收起，减少动态效果时直接切换。
import { Collapsible as CollapsiblePrimitive } from 'radix-ui'
import { type ComponentPropsWithoutRef, forwardRef } from 'react'
import { cn } from '../lib/utils.ts'

type CollapsibleProps = ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>

function Collapsible(props: CollapsibleProps) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />
}

type CollapsibleTriggerProps = ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger>

const CollapsibleTrigger = forwardRef<HTMLButtonElement, CollapsibleTriggerProps>(
  ({ className, ...props }, ref) => (
    <CollapsiblePrimitive.Trigger
      ref={ref}
      data-slot="collapsible-trigger"
      className={cn(
        'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--focus-ring)',
        className,
      )}
      {...props}
    />
  ),
)
CollapsibleTrigger.displayName = 'CollapsibleTrigger'

type CollapsibleContentProps = ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>

const CollapsibleContent = forwardRef<HTMLDivElement, CollapsibleContentProps>(
  ({ className, ...props }, ref) => (
    <CollapsiblePrimitive.Content
      ref={ref}
      data-slot="collapsible-content"
      className={cn(
        'overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  ),
)
CollapsibleContent.displayName = 'CollapsibleContent'

export {
  Collapsible,
  CollapsibleContent,
  type CollapsibleContentProps,
  type CollapsibleProps,
  CollapsibleTrigger,
  type CollapsibleTriggerProps,
}
