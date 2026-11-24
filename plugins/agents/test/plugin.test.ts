import {
  defineTemplateConfig,
  PluginConfigError,
  pluginsForTarget,
  resolvePlugins,
} from '@saas/config'
import { describe, expect, it } from 'vitest'
import templateConfig from '../../../template.config.ts'
import manifest from '../plugin.ts'
import { agentsConfigSchema } from '../src/config.ts'

const app = { name: 'MyApp', url: 'https://example.com', supportEmail: 'support@example.com' }

describe('agents 插件清单', () => {
  it('配置段默认值：maxSteps 8、maxPersistedMessages 200，保留期与单轮封顶默认不设置', () => {
    expect(agentsConfigSchema.parse({})).toEqual({
      maxSteps: 8,
      maxPersistedMessages: 200,
      defaultAgent: 'assistant',
    })
  })

  it('拒绝未知键与非法取值', () => {
    expect(agentsConfigSchema.safeParse({ maxStep: 8 }).success).toBe(false)
    expect(agentsConfigSchema.safeParse({ maxSteps: 0 }).success).toBe(false)
    expect(agentsConfigSchema.safeParse({ retentionDays: 0 }).success).toBe(false)
    expect(agentsConfigSchema.safeParse({ maxTurnCredits: 1.5 }).success).toBe(false)
    expect(agentsConfigSchema.safeParse({ defaultAgent: 'My Agent' }).success).toBe(false)
  })

  it('仅 Cloudflare，web 导出 Durable Object 类，jobs 不绑定（避免两个 Worker 循环依赖）', () => {
    expect(manifest.targets).toEqual(['cloudflare'])
    expect(manifest.bindings.web).toEqual([
      { name: 'AGENT_CONVERSATION', kind: 'durable_object', className: 'AgentConversation' },
    ])
    expect(manifest.bindings).not.toHaveProperty('jobs')
  })

  it('需要计费与积分开关', () => {
    const config = defineTemplateConfig({
      app,
      billing: { enabled: false },
      // AI 依赖计费：关闭计费时 AI 也须关闭，配置本身才合法
      ai: { text: { enabled: false }, image: false, video: false },
      plugins: { agents: {} },
    })
    try {
      resolvePlugins(config, [manifest])
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(PluginConfigError)
      expect((error as PluginConfigError).issues).toContain(
        'plugins.agents requires billing.enabled to be enabled',
      )
    }
  })

  it('模板配置启用 agents 且通过校验；selfhost 目标排除', () => {
    const resolved = resolvePlugins(templateConfig, [manifest])
    expect(resolved.map((plugin) => plugin.manifest.id)).toEqual(['agents'])
    expect(pluginsForTarget(resolved, 'node').excluded).toHaveLength(1)
  })
})
