import { m } from '@web/paraglide/messages.js'

// 对话页加载骨架单独成文件：路由的 pendingComponent 不参与默认代码分割，与对话页同模块时会把
// agents SDK 与整个对话 UI 拉进客户端入口包（同 features/ai/chat-page-skeleton.tsx）
/** 对话页加载中（设计稿 Main.dc.html 的 loading） */
export function AgentChatSkeleton() {
  return (
    <div
      className="mx-auto flex w-full max-w-180 flex-col gap-6 pt-2"
      role="status"
      aria-label={m.agents_loading()}
    >
      <span className="h-10 w-3/4 max-w-75 animate-pulse self-end rounded-xl bg-active motion-reduce:animate-none" />
      <div className="flex items-start gap-3">
        <span className="size-7 shrink-0 animate-pulse rounded-full bg-active motion-reduce:animate-none" />
        <span className="flex flex-1 flex-col gap-2">
          <span className="h-8.5 animate-pulse rounded-lg bg-active motion-reduce:animate-none" />
          <span className="h-3 w-11/12 animate-pulse rounded-md bg-active motion-reduce:animate-none" />
          <span className="h-3 w-2/3 animate-pulse rounded-md bg-active motion-reduce:animate-none" />
        </span>
      </div>
    </div>
  )
}
