import { createFileRoute, useRouter } from '@tanstack/react-router'
import { m } from '@web/paraglide/messages.js'
import { listAgentConversations } from '../../../../src/web/agents.functions.ts'
import { AgentListPage } from '../../../../src/web/list-page.tsx'
import { AgentListError, AgentListSkeleton } from '../../../../src/web/list-states.tsx'

export const Route = createFileRoute('/app/$slug/agents/')({
  loader: ({ params }) => listAgentConversations({ data: { slug: params.slug } }),
  staleTime: 0,
  head: () => ({ meta: [{ title: m.agents_title() }] }),
  component: AgentsPage,
  pendingComponent: AgentListSkeleton,
  errorComponent: AgentsError,
  // 页头即页面标题（与对话页一致），顶部条不再重复「Agent」
  staticData: { shellTitle: false },
})

function AgentsPage() {
  const page = Route.useLoaderData()
  const { slug } = Route.useParams()
  return <AgentListPage slug={slug} page={page} />
}

function AgentsError() {
  const router = useRouter()
  return <AgentListError onRetry={() => void router.invalidate()} />
}
