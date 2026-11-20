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
    expect(preferredLocale(['pt'], locales)).toBe('pt-BR')
  })

  it('主语言回退不跨地区：pt-PT 不匹配 pt-BR，只回退到没写地区或地区相同的配置语言', () => {
    expect(preferredLocale(['pt-PT'], locales)).toBeNull()
    expect(preferredLocale(['pt-PT', 'en'], locales)).toBe('en')
    expect(preferredLocale(['pt-PT'], ['en', 'pt-BR', 'pt'])).toBe('pt')
    expect(preferredLocale(['pt-pt'], ['pt-BR', 'pt-PT'])).toBe('pt-PT')
    expect(preferredLocale(['en-US'], ['en-GB', 'fr'])).toBeNull()
    expect(preferredLocale(['en-US'], ['en-GB', 'en'])).toBe('en')
    // 写了地区的书写系统匹配同样不跨地区；没写地区的配置语言照常匹配
    expect(preferredLocale(['zh-HK'], ['en', 'zh-TW'])).toBeNull()
    expect(preferredLocale(['zh-HK'], ['en', 'zh-TW', 'zh-Hant'])).toBe('zh-Hant')
    // 主语言回退不跨书写系统：只配置简体时繁体标签不匹配
    expect(preferredLocale(['zh-TW'], ['en', 'zh-Hans'])).toBeNull()
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
