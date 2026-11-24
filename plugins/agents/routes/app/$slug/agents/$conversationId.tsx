import { createFileRoute, Link } from '@tanstack/react-router'
import { useAppShellBarAvailable } from '@web/features/app-shell/bar.tsx'
import { m } from '@web/paraglide/messages.js'
import { getAgentConversation } from '../../../../src/web/agents.functions.ts'
import { AgentChatPage } from '../../../../src/web/chat-page.tsx'
import { AgentChatSkeleton } from '../../../../src/web/chat-skeleton.tsx'

export const Route = createFileRoute('/app/$slug/agents/$conversationId')({
  loader: ({ params }) =>
    getAgentConversation({
      data: { slug: params.slug, conversationId: params.conversationId },
    }),
  staleTime: 0,
  head: ({ loaderData }) => ({
    meta: loaderData ? [{ title: loaderData.conversation.title || m.agents_untitled() }] : [],
  }),
  component: AgentConversationPage,
  pendingComponent: AgentChatSkeleton,
  // 对话区头部即页面标题；输入区贴底，不显示浮动语言 / 主题控件（与文本对话页一致）
  staticData: { shellTitle: false, floatingControls: false },
  notFoundComponent: AgentConversationNotFound,
})

function AgentConversationNotFound() {
  const { slug } = Route.useParams()
  const Heading = useAppShellBarAvailable() ? 'h1' : 'h2'
  return (
    <section className="grid gap-2">
      <Heading className="font-semibold text-title">{m.agents_not_found_title()}</Heading>
      <p>{m.agents_not_found_body()}</p>
      <Link to="/app/$slug/agents" params={{ slug }} className="underline">
        {m.agents_all_chats()}
      </Link>
    </section>
  )
}

function AgentConversationPage() {
  const page = Route.useLoaderData()
  const { slug } = Route.useParams()
  return <AgentChatPage key={page.conversation.id} slug={slug} page={page} />
}
