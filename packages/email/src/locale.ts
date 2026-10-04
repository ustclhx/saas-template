/**
 * 邮件语言：按收件人的 `user.locale` 选择，暂只支持 en 与 zh。
 * 完整的 i18n 方案（文案文件、更多语言）在 P6 `add-marketing-i18n-seo` 中接入。
 */
export const EMAIL_LOCALES = ['en', 'zh'] as const
export type EmailLocale = (typeof EMAIL_LOCALES)[number]
export const DEFAULT_EMAIL_LOCALE: EmailLocale = 'en'

/** `zh`、`zh-CN`、`zh_Hant` 等归为 zh；未设置或不支持的语言回退到 en。 */
export function resolveEmailLocale(locale: string | null | undefined): EmailLocale {
  const language = locale?.trim().toLowerCase().split(/[-_]/)[0]
  return EMAIL_LOCALES.find((l) => l === language) ?? DEFAULT_EMAIL_LOCALE
}
