import { describe, expect, it } from 'vitest'
import manifest from '../plugin.ts'
import { enabledStudioKinds } from '../src/kinds.ts'

describe('Studio 配置', () => {
  it('在插件清单中提供默认值', () => {
    expect(manifest.config.parse({})).toEqual({
      kinds: ['image', 'video'],
      publishDailyLimit: 20,
      reportHideThreshold: 3,
      galleryPageSize: 24,
    })
  })

  it.each([
    { kind: ['image'] },
    { kinds: ['text'] },
    { publishDailyLimit: 0 },
    { reportHideThreshold: 1.5 },
    { galleryPageSize: -1 },
  ])('拒绝无效配置 %j', (config) => {
    expect(manifest.config.safeParse(config).success).toBe(false)
  })
})

describe('可用的 Studio 模式', () => {
  it('未启用插件时没有可用模式', () => {
    expect(enabledStudioKinds({ plugins: {}, ai: { image: true, video: true } })).toEqual([])
  })

  it('默认模式受 AI 开关限制', () => {
    const plugins = { studio: {} }
    expect(enabledStudioKinds({ plugins, ai: { image: true, video: true } })).toEqual([
      'image',
      'video',
    ])
    expect(enabledStudioKinds({ plugins, ai: { image: false, video: true } })).toEqual(['video'])
  })

  it('只返回配置中列出且已启用 AI 的模式', () => {
    const plugins = { studio: { kinds: ['image'] } }
    expect(enabledStudioKinds({ plugins, ai: { image: true, video: true } })).toEqual(['image'])
    expect(enabledStudioKinds({ plugins, ai: { image: false, video: true } })).toEqual([])
  })

  it('支持显式关闭全部模式', () => {
    const plugins = { studio: { kinds: [] } }
    expect(enabledStudioKinds({ plugins, ai: { image: true, video: true } })).toEqual([])
  })
})
