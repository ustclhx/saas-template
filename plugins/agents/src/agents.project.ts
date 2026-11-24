import { defineAgent } from './definition.ts'

export const projectAgents = [
  defineAgent({
    id: 'assistant',
    name: 'Assistant',
    description: 'Answers questions, checks the current time, and lists recent workspace files.',
    systemPrompt: () =>
      'You are a workspace assistant. Reply in the user’s language. Use the available tools to verify the current time or list recent workspace files when asked.',
    tools: ['current_time', 'list_workspace_files'],
  }),
] as const
