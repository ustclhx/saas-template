import { LanguagePrompt } from '@saas/ui'
import { useLocation } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { baseLocale, getLocale, type Locale, locales } from '../../paraglide/runtime.js'
import { templateConfig } from '../../server/template-config.ts'
import type { PageAlternates } from '../seo/alternates.ts'
import { browserLanguages, preferredLocale } from './browser-locale.ts'
import { textDirection } from './direction.ts'
import { homeLocaleTarget, readHomeLocale, signedInHint } from './home-locale.ts'
import { usePageAlternates } from './page-alternates.ts'
import { rememberLocale } from './preference.ts'

/** 本浏览器关闭过语言提示的记录（localStorage）；任何语言的提示关闭一次后都不再出现 */
export const PROMPT_DISMISSED_KEY = 'saas:language-prompt-dismissed'
/** 水合后等浏览器空闲再挂载，最长等待（毫秒），不与首屏渲染争抢 */
export const PROMPT_IDLE_TIMEOUT_MS = 1500

function promptDismissed(): boolean {
  try {
    return window.localStorage.getItem(PROMPT_DISMISSED_KEY) !== null
  } catch {
    // 读取失败：本次照常显示
    return false
  }
}

function dismissPrompt(): void {
  try {
    window.localStorage.setItem(PROMPT_DISMISSED_KEY, '1')
  } catch {
    // 写入失败：只是本次不再显示
  }
}

/**
 * 语言提示的目标：浏览器偏好中最先匹配到的配置语言，不是当前语言、且本页 hreflang 中有该语言版本。
 * 最先匹配到当前语言、或该语言没有已发布版本（未翻译页）时不提示。
 */
export function promptTarget({
  locale,
  languages,
  locales: configured,
  alternates,
}: {
  locale: string
  languages: readonly string[]
  locales: readonly Locale[]
  alternates: PageAlternates
}): { locale: Locale; href: string } | null {
  if (!alternates) return null
  const preferred = preferredLocale(languages, configured)
  if (!preferred || preferred === locale) return null
  const href = alternates.get(preferred)
  return href === undefined ? null : { locale: preferred, href }
}

function whenIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: PROMPT_IDLE_TIMEOUT_MS })
    return () => window.cancelIdleCallback(id)
  }
  const id = window.setTimeout(callback, 1)
  return () => window.clearTimeout(id)
}

/**
 * 公开页水合后的语言辅助（multilingual-seo 4.2、4.4），服务端与预渲染输出中没有任何内容：
 * 1. 首页记住语言（ML-09，默认关闭）：条件满足时 `location.replace` 到所选语言首页，不再提示；
 * 2. 否则在浏览器空闲时（最长 1.5s）按 navigator.languages 与本页 hreflang 挂载语言提示条
 *    （设计稿 docs/design-system/prototypes/multilingual-seo/）。文案取目标语言的 messages。
 * 只由根布局在公开页挂载（应用区、后台不挂载）；提示与关闭都不产生服务端 Set-Cookie。
 */
export function LanguageAssist() {
  const pathname = useLocation({ select: (location) => location.pathname })
  const alternates = usePageAlternates()
  const [prompt, setPrompt] = useState<{ locale: Locale; href: string } | null>(null)
  const locale = getLocale()
  const shown = useRef(false)
  useEffect(() => {
    shown.current = prompt !== null
  }, [prompt])

  useEffect(() => {
    const target = homeLocaleTarget({
      enabled: templateConfig.i18n.rememberHomeLocale,
      pathname,
      locale,
      baseLocale,
      locales,
      marker: readHomeLocale(),
      signedIn: signedInHint(),
      alternates,
    })
    if (target) {
      window.location.replace(target)
      return
    }
    const next = promptDismissed()
      ? null
      : promptTarget({ locale, languages: browserLanguages(navigator), locales, alternates })
    // 已显示时随客户端导航直接更新目标（或在新页面上收起）；首次显示等浏览器空闲
    if (shown.current) {
      setPrompt(next)
      return
    }
    if (!next) return
    return whenIdle(() => setPrompt(next))
  }, [pathname, locale, alternates])

  if (!prompt) return null
  const options = { locale: prompt.locale }
  return (
    <LanguagePrompt
      key={prompt.locale}
      href={prompt.href}
      hrefLang={prompt.locale}
      dir={textDirection(prompt.locale)}
      labels={{
        region: m.i18n_prompt_region({}, options),
        message: m.i18n_prompt_message({}, options),
        action: m.i18n_prompt_action({}, options),
        close: m.i18n_prompt_close({}, options),
      }}
      onFollow={() => rememberLocale(prompt.locale)}
      onDismiss={() => {
        dismissPrompt()
        setPrompt(null)
      }}
    />
  )
}
