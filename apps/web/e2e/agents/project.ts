import { type AgentToolContext, defineAgentTool, pendingTaskOutput } from '@saas/ai'
import { aiTask, type Database, scoped } from '@saas/db'
import { newId } from '@saas/shared'
import { z } from 'zod'

export const APPROVAL_TOOL = 'confirm_test_note'
/** 异步工具结果（add-ai-agents 8.2）：提交一个本地任务行并返回 pending，结果由实例轮询 ai_task 写回 */
export const ASYNC_TOOL = 'submit_test_task'
export const projectTools = [
  defineAgentTool<z.ZodObject<Record<string, never>>, unknown, AgentToolContext<Database, unknown>>(
    {
      name: ASYNC_TOOL,
      description: 'Submit a fixture background task.',
      input: z.object({}),
      execute: async (_input, ctx) => {
        const id = newId()
        await scoped(ctx.db, ctx.workspaceId).insert(aiTask, {
          id,
          userId: ctx.userId,
          kind: 'image',
          modelKey: 'agents-e2e-task',
          provider: 'local',
          pricing: { mode: 'per_call', credits: 1 },
          status: 'running',
          input: { params: { prompt: 'fixture' } },
          providerRequestKey: id,
          deadlineAt: new Date(Date.now() + 10 * 60_000),
        })
        return pendingTaskOutput(id, 'image')
      },
    },
  ),
  defineAgentTool({
    name: APPROVAL_TOOL,
    description: 'Return a fixture note after approval.',
    input: z.object({ note: z.string() }),
    needsApproval: true,
    execute: async ({ note }) => ({ savedNote: note }),
  }),
]

export const projectAgents = [
  {
    id: 'e2e-assistant',
    name: 'E2E assistant',
    description: 'Runs scripted tool calls and replies for the local browser test.',
    systemPrompt: () => 'Use the provided tools.',
    tools: ['current_time', 'list_workspace_files', APPROVAL_TOOL, ASYNC_TOOL],
  },
]
