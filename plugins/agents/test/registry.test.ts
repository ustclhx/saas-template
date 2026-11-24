import { defineAgentTool } from '@saas/ai'
import type { Database } from '@saas/db'
import { log } from '@saas/shared/log'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  getAgent,
  listAgents,
  registerPluginAgentTools,
  resolveAgentTools,
} from '../src/registry.ts'

describe('agent 工具注册', () => {
  it('只提供所选 agent 的工具', () => {
    const tool = defineAgentTool({
      name: 'another_plugin_tool',
      description: 'A tool the assistant cannot use',
      input: z.object({}),
      execute: async () => 'not available to the assistant',
    })
    registerPluginAgentTools([{ id: 'example', entry: { default: {}, agentTools: () => [tool] } }])

    const agent = getAgent('assistant')
    expect(listAgents()).toContain(agent)
    expect(getAgent('missing')).toBeUndefined()
    const tools = resolveAgentTools('assistant', {
      db: {} as Database,
      turnId: 'turn-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      conversationId: 'conversation-1',
      signal: undefined,
      services: undefined,
      log,
    })
    expect(Object.keys(tools)).toEqual(['current_time', 'list_workspace_files'])
    expect(tools.constructor).toBeUndefined()
  })

  it('启动时拒绝插件和内置示例之间的同名工具', () => {
    const duplicate = defineAgentTool({
      name: 'current_time',
      description: 'Duplicate name',
      input: z.object({}),
      execute: async () => ({}),
    })

    expect(() =>
      registerPluginAgentTools([
        { id: 'example', entry: { default: {}, agentTools: [duplicate] } },
      ]),
    ).toThrow('Duplicate agent tool "current_time" from agents examples and plugin example')
  })
})
