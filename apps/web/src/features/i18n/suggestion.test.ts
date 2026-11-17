import { describe, expect, it } from 'vitest'
import { localeSuggestionScript, SUGGESTION_ATTRIBUTE, suggestionCss } from './suggestion.ts'

const script = localeSuggestionScript({
  baseLocale: 'en',
  locales: ['en', 'zh', 'pt-BR'],
  preferenceCookie: 'locale-preference',
})

/** 在假的 document / navigator 上执行首帧脚本，返回写到 <html> 上的建议 */
function run({
  lang = 'en',
  languages,
  cookie = '',
}: {
  lang?: string
  languages: readonly string[] | undefined
  cookie?: string
}) {
  const attributes = new Map<string, string>()
  const document = {
    cookie,
    documentElement: {
      lang,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
    },
  }
  const navigator = { languages, language: languages?.[0] }
  new Function('document', 'navigator', script)(document, navigator)
  return attributes.get(SUGGESTION_ATTRIBUTE) ?? null
}

describe('首帧前的语言建议脚本', () => {
  it('按浏览器偏好顺序取第一个配置语言：地区标签退回主语言，完整标签优先', () => {
    expect(run({ languages: ['fr', 'zh-CN', 'en'] })).toBe('zh')
    expect(run({ languages: ['pt-BR', 'zh'] })).toBe('pt-BR')
    expect(run({ languages: ['ZH-tw'] })).toBe('zh')
  })

  it('默认语言排在前面、没有匹配或缺少 languages 时不建议', () => {
    expect(run({ languages: ['en-US', 'zh'] })).toBeNull()
    expect(run({ languages: ['fr', 'de'] })).toBeNull()
    expect(run({ languages: [] })).toBeNull()
    expect(run({ languages: undefined })).toBeNull()
  })

  it('非默认语言页面或已手动选择（偏好 Cookie）时不建议', () => {
    expect(run({ lang: 'zh', languages: ['zh-CN'] })).toBeNull()
    expect(run({ languages: ['zh-CN'], cookie: 'a=1; locale-preference=en' })).toBeNull()
    // 名称相近的其他 Cookie 不影响
    expect(run({ languages: ['zh-CN'], cookie: 'x-locale-preference=en' })).toBe('zh')
  })

  it('显示规则只匹配与 <html> 属性相同的候选横幅', () => {
    expect(suggestionCss(['zh', 'pt-BR'])).toBe(
      ':root[data-locale-suggestion="zh"] [data-locale-suggestion-for="zh"]{display:flex}' +
        ':root[data-locale-suggestion="pt-BR"] [data-locale-suggestion-for="pt-BR"]{display:flex}',
    )
  })
})
