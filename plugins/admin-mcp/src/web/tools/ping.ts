import { z } from 'zod'
import { defineAdminTool } from './define.ts'

export const pingTool = defineAdminTool({
  name: 'ping',
  scope: 'admin:read',
  description: 'Check the MCP connection by returning pong.',
  input: z.object({}),
  params: {},
  run: () => ({ content: [{ type: 'text', text: 'pong' }] }),
})
