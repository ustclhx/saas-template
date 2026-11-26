import { describe, expect, it } from 'vitest'
import manifest from '../plugin.ts'
import { enabledStudioKinds } from '../src/kinds.ts'
import { resolveStudioSite, studioSiteOrigin } from '../src/site.ts'

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
    { sites: { gallery: 'invalid' } },
    { sites: { gallery: 'https://example.test/gallery' } },
    { sites: { first: 'https://example.test', second: 'https://example.test' } },
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

describe('Studio 站点来源', () => {
  const app = 'https://example.test'
  const gallery = 'https://gallery.example.test'

  it('使用同一规范来源解析多站点请求和旧版媒体清除地址', () => {
    const sites = { gallery }
    expect(resolveStudioSite(gallery, app, sites)).toEqual({ key: 'gallery', origin: gallery })
    expect(studioSiteOrigin('gallery', app, sites)).toBe(gallery)
    expect(resolveStudioSite('https://other.example.test', app, sites)).toBeNull()
    expect(studioSiteOrigin('other', app, sites)).toBeUndefined()
  })

  it('单站点的预览域名沿用默认站点键和 APP_URL 规范来源', () => {
    expect(resolveStudioSite('http://localhost:3000', app)).toEqual({ key: 'default', origin: app })
    expect(studioSiteOrigin('default', app)).toBe(app)
  })
})
