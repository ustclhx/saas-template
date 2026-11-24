import { defineAgentTool } from '@saas/ai'
import { z } from 'zod'

export const APPROVAL_TOOL = 'confirm_test_note'
export const projectTools = [
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
    tools: ['current_time', 'list_workspace_files', APPROVAL_TOOL],
  },
]
