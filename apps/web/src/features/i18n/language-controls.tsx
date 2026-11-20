import { LanguageMenu, type LanguageMenuItem } from '@saas/ui'
import { useLocation } from '@tanstack/react-router'
import { type MouseEvent, useEffect, useState } from 'react'
import { m } from '../../paraglide/messages.js'
import { getLocale, isLocale, type Locale } from '../../paraglide/runtime.js'
import { languageOptions } from '../seo/alternates.ts'
import { isAppAreaPath } from './app-area.ts'
import { rememberHomeLocale, signedInHint } from './home-locale.ts'
import { usePageAlternates } from './page-alternates.ts'
import { saveLanguagePreference } from './preference.functions.ts'
import { rememberLocale } from './preference.ts'

/** 语言的自称（如「中文」「English」） */
function languageName(locale: string): string {
  return new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale
}

/**
 * 语言切换器（multilingual-seo 4.3，设计稿 multilingual-seo/Switcher 方案 A）：链接菜单，每项是普通
 * `<a href hreflang>`，只列本页 hreflang 中真实存在的语言版本；应用区列出全部语言，选择后写 Cookie 并保存到账号。
 * 默认固定在左下角（仅 md 及以上；手机端改由页脚设置行 SiteSettings 渲染）；
 * `placement="inline"` 用于后台侧栏等自带位置的容器，`bare` 用于设置行与工作台侧栏。
 * 外层带 data-link-zone="nav"：语言切换属于导航层，链接图检查不把它计为正文链接。
 *
 * 点击某一项：
 * - 浏览器端写 Paraglide Cookie（应用区按它选语言），公开页不产生服务端 Set-Cookie；
 * - 应用区，或客户端认为已登录（home-locale.ts 的登录信号）时，先保存到账号设置再跳转，其他设备的应用区随之生效；
 *   已登录时同时写首页记住语言的标记（ML-09）。匿名访客不请求服务端，由链接直接跳转。
 */
export function LanguageControls({
  placement = 'floating',
}: {
  placement?: 'floating' | 'inline' | 'bare'
} = {}) {
  const floating = placement === 'floating'
  const pathname = useLocation({ select: (location) => location.pathname })
  const alternates = usePageAlternates()
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locale = getLocale()
  const appArea = isAppAreaPath(pathname)
  const items: LanguageMenuItem[] = languageOptions({ locale, pathname, alternates, appArea }).map(
    (option) => ({ ...option, label: languageName(option.locale) }),
  )
  useEffect(() => setReady(true), [])

  async function save(next: Locale, href: string) {
    setBusy(true)
    setError(null)
    try {
      await saveLanguagePreference({ data: next })
      // 完整导航让账号语言、SSR 与客户端同时刷新；应用区停留在当前地址（含查询参数）
      window.location.assign(appArea ? window.location.href : href)
    } catch {
      setError(m.i18n_save_failed())
      setBusy(false)
    }
  }

  function select(item: LanguageMenuItem, event: MouseEvent<HTMLElement>) {
    if (!isLocale(item.locale)) return
    const next = item.locale
    if (busy) {
      event.preventDefault()
      return
    }
    rememberLocale(next)
    rememberHomeLocale(next)
    if (appArea || signedInHint()) {
      event.preventDefault()
      void save(next, item.href)
    }
    // 其他情况：普通链接自行跳转
  }

  return (
    <>
      <div
        data-link-zone="nav"
        className={
          floating
            ? 'fixed bottom-4 left-4 z-(--z-sticky) rounded-md max-md:hidden bg-background px-3 py-2 text-sm shadow-sm print:hidden'
            : placement === 'bare'
              ? 'inline-flex w-fit text-sm'
              : 'inline-flex w-fit rounded-md bg-background px-3 py-1.5 text-sm shadow-xs'
        }
      >
        <LanguageMenu
          label={m.i18n_language()}
          items={items}
          disabled={!ready || busy}
          className="w-full"
          onItemClick={select}
        />
      </div>
      {error && (
        <p
          role="alert"
          className={
            floating
              ? 'fixed bottom-16 left-4 z-(--z-sticky) max-md:hidden'
              : 'text-destructive text-sm'
          }
        >
          {error}
        </p>
      )}
    </>
  )
}
