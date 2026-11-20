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

interface Subtags {
  readonly language: string
  /** 显式写出的书写系统子标签（小写），没有时为空串 */
  readonly script: string
  /** 显式写出的地区子标签（大写），没有时为空串 */
  readonly region: string
}

function subtags(tag: string): Subtags | null {
  try {
    const locale = new Intl.Locale(tag)
    return {
      language: locale.language.toLowerCase(),
      script: (locale.script ?? '').toLowerCase(),
      region: (locale.region ?? '').toUpperCase(),
    }
  } catch {
    return null
  }
}

/**
 * 按浏览器偏好顺序（navigator.languages）取第一个能匹配到的配置语言：
 * 完整标签（不区分大小写）→ 语言加书写系统 → 主语言子标签。没有匹配时返回 null。
 * 后两步只回退到地区不冲突的配置语言：配置语言写了地区（如 pt-BR）而浏览器标签写了另一个地区（pt-PT）时
 * 不匹配，不从一个地区跳到另一个地区；没写地区的配置语言（pt）或没写地区的浏览器标签（pt）不冲突。
 * 主语言一步还要求书写系统不冲突（zh-TW 不回退到 zh-Hans），zh-TW → zh-Hant 由书写系统一步完成。
 * 最先匹配到的语言即访客最想要的语言：调用方据此判断，不再看后面的偏好
 * （如偏好 zh-TW、zh-CN 而本页只有 zh-Hans 时，不应劝繁体用户改看简体）。
 */
export function preferredLocale<L extends string>(
  languages: readonly string[] | undefined,
  locales: readonly L[],
): L | null {
  const byTag = new Map(locales.map((locale) => [locale.toLowerCase(), locale]))
  const configured = locales.flatMap((locale) => {
    const parts = subtags(locale)
    return parts ? [{ locale, ...parts, key: scriptKey(locale) }] : []
  })
  for (const language of languages ?? []) {
    const tag = String(language).toLowerCase()
    if (!tag) continue
    const exact = byTag.get(tag)
    if (exact) return exact
    const wanted = subtags(tag)
    if (!wanted) continue
    const regionOk = (region: string) => !region || !wanted.region || region === wanted.region
    const key = scriptKey(tag)
    // 多个配置语言补全相同时取先配置的一个
    const byScript = key
      ? configured.find((entry) => entry.key === key && regionOk(entry.region))
      : undefined
    if (byScript) return byScript.locale
    const script = key.split('-')[1] ?? ''
    const byLanguage = configured.find(
      (entry) =>
        entry.language === wanted.language &&
        regionOk(entry.region) &&
        (!entry.script || !script || entry.script === script),
    )
    if (byLanguage) return byLanguage.locale
  }
  return null
}

/** 浏览器的语言偏好列表；旧浏览器只有 navigator.language */
export function browserLanguages(nav: Pick<Navigator, 'languages' | 'language'>): string[] {
  return nav.languages?.length ? [...nav.languages] : nav.language ? [nav.language] : []
}
