import { Button } from '@saas/ui'
import { CircleAlert } from '@saas/ui/icons'
import { m } from '@web/paraglide/messages.js'

// 列表页的加载与失败态单独成文件：路由的 pendingComponent / errorComponent 不参与默认代码分割，
// 与列表页同模块时会把对话格式化（含 zod schema）拉进客户端入口包（check-home-bundle 拦截）

/** 加载中（路由 pendingComponent，设计稿 List.dc.html 的 loading） */
export function AgentListSkeleton() {
  return (
    <div
      role="status"
      aria-label={m.agents_loading()}
      className="mx-auto flex w-full max-w-240 flex-col gap-3 rounded-xl p-4 inset-ring inset-ring-border"
    >
      <span className="h-4 w-2/5 animate-pulse rounded-md bg-active motion-reduce:animate-none" />
      <span className="h-4 w-2/3 animate-pulse rounded-md bg-active motion-reduce:animate-none" />
      <span className="h-4 w-1/2 animate-pulse rounded-md bg-active motion-reduce:animate-none" />
    </div>
  )
}

/** 加载失败（路由 errorComponent，设计稿 List.dc.html 的 error）：重试重新执行 loader */
export function AgentListError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mx-auto flex w-full max-w-240 flex-col gap-5">
      <div role="alert" className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3">
        <CircleAlert aria-hidden className="size-4 shrink-0 text-destructive" strokeWidth={1.5} />
        <span className="flex-1">{m.agents_list_error()}</span>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {m.agents_retry()}
        </Button>
      </div>
    </div>
  )
}
