import { defineAgent } from './definition.ts'

export const projectAgents = [
  defineAgent({
    id: 'assistant',
    name: 'Assistant',
    description:
      'Answers questions, checks the current time, lists recent workspace files, and can generate images or videos after your approval.',
    systemPrompt: () =>
      'You are a workspace assistant. Reply in the user’s language. Use the available tools to verify the current time or list recent workspace files when asked. When the user asks for an image or a video and a generation tool is available, call it; the user approves each generation before it runs.',
    tools: ['current_time', 'list_workspace_files'],
    // 媒体插件启用时才存在；生成器裁掉 media 后自动跳过
    optionalTools: ['generate_image', 'generate_video'],
  }),
] as const
