// 浏览器语言偏好匹配（multilingual-seo 4.1 自 suggestion.ts 迁移）：水合后的语言提示条用它决定
// 访客最想要的已配置语言。只在浏览器端运行，不参与服务端渲染与路由（公开页不按 Accept-Language 选择语言）。

/**
 * 书写系统匹配键：补全标签（likely subtags）后的「语言-书写系统」，小写。
 * 使配置 zh-Hant / zh-Hans 时无需额外配置即可匹配 zh-TW、zh-HK → zh-Hant，zh-CN、zh-SG、zh → zh-Hans；
 * 只配置 zh 时 zh-TW（zh-Hant）补全不到 zh（zh-Hans），由主语言子标签兜底。无法解析时返回空串。
 */
export function scriptKey(tag: string): string {
  try {
    const locale = new Intl.Locale(tag).maximize()
    return locale.script ? `${locale.language}-${locale.script}`.toLowerCase() : ''
  } catch {
    return ''
  }
}

/**
 * 按浏览器偏好顺序（navigator.languages）取第一个能匹配到的配置语言：
 * 完整标签（不区分大小写）→ 语言加书写系统 → 主语言子标签。没有匹配时返回 null。
 * 最先匹配到的语言即访客最想要的语言：调用方据此判断，不再看后面的偏好
 * （如偏好 zh-TW、zh-CN 而本页只有 zh-Hans 时，不应劝繁体用户改看简体）。
 */
export function preferredLocale<L extends string>(
  languages: readonly string[] | undefined,
  locales: readonly L[],
): L | null {
  const byTag = new Map(locales.map((locale) => [locale.toLowerCase(), locale]))
  const byScript = new Map<string, L>()
  for (const locale of locales) {
    const key = scriptKey(locale)
    // 多个配置语言补全相同时取先配置的一个
    if (key && !byScript.has(key)) byScript.set(key, locale)
  }
  for (const language of languages ?? []) {
    const tag = String(language).toLowerCase()
    if (!tag) continue
    const match =
      byTag.get(tag) ?? byScript.get(scriptKey(tag)) ?? byTag.get(tag.split('-')[0] ?? '')
    if (match) return match
  }
  return null
}

/** 浏览器的语言偏好列表；旧浏览器只有 navigator.language */
export function browserLanguages(nav: Pick<Navigator, 'languages' | 'language'>): string[] {
  return nav.languages?.length ? [...nav.languages] : nav.language ? [nav.language] : []
}
