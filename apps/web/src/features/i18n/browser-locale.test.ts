import { describe, expect, it } from 'vitest'
import { browserLanguages, preferredLocale, scriptKey } from './browser-locale.ts'

const locales = ['en', 'zh', 'pt-BR'] as const

describe('浏览器语言偏好匹配', () => {
  it('按浏览器偏好顺序取第一个配置语言：地区标签退回主语言，完整标签优先', () => {
    expect(preferredLocale(['fr', 'zh-CN', 'en'], locales)).toBe('zh')
    expect(preferredLocale(['pt-BR', 'zh'], locales)).toBe('pt-BR')
    expect(preferredLocale(['ZH-tw'], locales)).toBe('zh')
  })

  it('配置按书写系统区分的语言时，地区标签按补全后的书写系统匹配', () => {
    const scripts = ['en', 'zh-Hant', 'zh-Hans'] as const
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant'])
      expect(preferredLocale([tag], scripts), tag).toBe('zh-Hant')
    for (const tag of ['zh-CN', 'zh-SG', 'zh', 'zh-hans-cn'])
      expect(preferredLocale([tag], scripts), tag).toBe('zh-Hans')
    // 完整标签仍优先于书写系统
    expect(preferredLocale(['zh-TW'], ['en', 'zh-Hans', 'zh-TW'])).toBe('zh-TW')
  })

  it('只配置 zh 时繁体地区标签由主语言子标签兜底', () => {
    for (const tag of ['zh-TW', 'zh-HK', 'zh-CN', 'zh-Hant', 'zh'])
      expect(preferredLocale([tag], locales), tag).toBe('zh')
    expect(preferredLocale(['pt-PT'], locales)).toBe('pt-BR')
    expect(preferredLocale(['pt'], locales)).toBe('pt-BR')
  })

  it('最先匹配的是默认语言时返回默认语言；没有匹配或缺少 languages 时为 null', () => {
    expect(preferredLocale(['en-US', 'zh'], locales)).toBe('en')
    expect(preferredLocale(['fr', 'de'], locales)).toBeNull()
    expect(preferredLocale([], locales)).toBeNull()
    expect(preferredLocale(undefined, locales)).toBeNull()
    expect(preferredLocale([''], locales)).toBeNull()
  })

  it('scriptKey 与 navigator 回退', () => {
    expect(scriptKey('zh-TW')).toBe('zh-hant')
    expect(scriptKey('zh')).toBe('zh-hans')
    expect(scriptKey('en')).toBe('en-latn')
    expect(scriptKey('not a tag')).toBe('')
    expect(browserLanguages({ languages: ['zh-CN', 'en'], language: 'zh-CN' })).toEqual([
      'zh-CN',
      'en',
    ])
    expect(browserLanguages({ languages: [], language: 'de' })).toEqual(['de'])
    expect(browserLanguages({ languages: [], language: '' })).toEqual([])
  })
})
