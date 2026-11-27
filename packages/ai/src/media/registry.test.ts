import { describe, expect, it } from 'vitest'
import { isSyncMediaProvider } from './provider.ts'
import { getMediaOutputHosts, requireMediaProviderDefinition } from './registry.ts'
import { WORKERS_AI_IMAGE_MODEL } from './workers-ai.ts'

describe('媒体服务商注册表', () => {
  it('未知、禁用与缺绑定的服务商均不能创建实例', () => {
    expect(() => requireMediaProviderDefinition('unknown', {})).toThrow('not enabled')
    expect(() =>
      requireMediaProviderDefinition('fal', { FAL_KEY: 'fixture' }, ['workers-ai']),
    ).toThrow('not enabled')
    expect(() => requireMediaProviderDefinition('workers-ai', {})).toThrow('not configured')
    expect(() => requireMediaProviderDefinition('fal', {})).toThrow('not configured')
  })

  it('fal 保持异步契约和原白名单，Workers AI 仅需绑定并返回同步实例', () => {
    const fal = requireMediaProviderDefinition('fal', { FAL_KEY: 'fixture' }).create(
      { FAL_KEY: 'fixture' },
      { modelId: 'fal-ai/fixture' },
    )
    expect(isSyncMediaProvider(fal)).toBe(false)
    expect(fal.capabilities.idempotentSubmit).toBe(false)
    expect(getMediaOutputHosts('fal')).toEqual(['fal.media', 'v3.fal.media', 'v3b.fal.media'])
    const env = { AI: { run: async () => ({ image: '' }) } }
    const sync = requireMediaProviderDefinition('workers-ai', env).create(env, {
      modelId: WORKERS_AI_IMAGE_MODEL,
    })
    expect(isSyncMediaProvider(sync)).toBe(true)
    expect(getMediaOutputHosts('workers-ai')).toEqual([])
  })
  it('Replicate 两个密钥都有才算已配置，产出白名单为精确主机', () => {
    const env = { REPLICATE_API_TOKEN: 'fixture', REPLICATE_WEBHOOK_SECRET: 'whsec_Zml4dHVyZQ==' }
    expect(() =>
      requireMediaProviderDefinition('replicate', { REPLICATE_API_TOKEN: 'fixture' }),
    ).toThrow('not configured')
    expect(() =>
      requireMediaProviderDefinition('replicate', {
        REPLICATE_WEBHOOK_SECRET: 'whsec_Zml4dHVyZQ==',
      }),
    ).toThrow('not configured')
    expect(() => requireMediaProviderDefinition('replicate', env, ['fal', 'workers-ai'])).toThrow(
      'not enabled',
    )
    const replicate = requireMediaProviderDefinition('replicate', env).create(env, {
      modelId: 'black-forest-labs/flux-schnell',
    })
    expect(isSyncMediaProvider(replicate)).toBe(false)
    expect(replicate.capabilities.idempotentSubmit).toBe(false)
    expect(getMediaOutputHosts('replicate')).toEqual(['replicate.delivery'])
  })
})
