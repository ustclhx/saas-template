/**
 * 页面书写方向（openspec multilingual-seo design.md 决策 5）：`<html dir>` 与页面语言一致。
 * 优先用 `Intl.Locale` 的文本信息；运行时不支持（旧 Firefox、部分 Node / workerd 版本）时查内置 RTL 表。
 */
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb'])

type TextInfoLocale = Intl.Locale & {
  getTextInfo?: () => { direction?: string }
  textInfo?: { direction?: string }
}

export function textDirection(locale: string): 'ltr' | 'rtl' {
  try {
    const intl = new Intl.Locale(locale) as TextInfoLocale
    const direction = intl.getTextInfo?.().direction ?? intl.textInfo?.direction
    if (direction === 'ltr' || direction === 'rtl') return direction
  } catch {
    // 非法语言标签按下方语言表判断
  }
  return RTL_LANGUAGES.has(locale.split('-')[0]?.toLowerCase() ?? '') ? 'rtl' : 'ltr'
}
