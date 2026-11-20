import { LanguagePrompt } from '@saas/ui'
import { m } from '../../paraglide/messages.js'
import type { Locale } from '../../paraglide/runtime.js'
import { textDirection } from './direction.ts'
import { rememberLocale } from './preference.ts'

/**
 * 语言提示条的渲染部分，由 LanguageAssist 按需懒加载（只在确实要提示时下载）：
 * 根布局在每个页面都会加载，提示条与它的图标不进入根布局和首页的静态依赖。
 * 文案取目标语言的 messages（Paraglide 的 locale 选项），容器带目标语言的 lang / dir。
 */
export default function LanguagePromptView({
  locale,
  href,
  onDismiss,
}: {
  locale: Locale
  href: string
  onDismiss: () => void
}) {
  const options = { locale }
  return (
    <LanguagePrompt
      href={href}
      hrefLang={locale}
      dir={textDirection(locale)}
      labels={{
        region: m.i18n_prompt_region({}, options),
        message: m.i18n_prompt_message({}, options),
        action: m.i18n_prompt_action({}, options),
        close: m.i18n_prompt_close({}, options),
      }}
      onFollow={() => rememberLocale(locale)}
      onDismiss={onDismiss}
    />
  )
}
