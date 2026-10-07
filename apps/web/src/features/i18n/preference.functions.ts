import { env } from 'cloudflare:workers'
import { createDb } from '@saas/db'
import { AppError } from '@saas/shared'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { baseLocale, isLocale } from '../../paraglide/runtime.js'
import { getAuth } from '../../server/auth.ts'
import { languageUrl, PREFERENCE_COOKIE, preferredLocale, readCookie } from './preference.ts'
import { readRequestSession } from './session.server.ts'

/** 水合后读取真实请求头，预渲染 HTML 不混入访客偏好。 */
export const getLanguageSuggestion = createServerFn({ method: 'GET' }).handler(() => {
  const request = getRequest()
  const first = languageUrl(request).pathname.split('/')[1]
  if (isLocale(first) || readCookie(request.headers.get('cookie') ?? '', PREFERENCE_COOKIE))
    return null
  const preferred = preferredLocale(request.headers.get('accept-language'))
  return preferred === baseLocale ? null : preferred
})

/** 手动选择也应用于已登录账号；没有有效会话时只由浏览器记 Cookie。 */
export const saveLanguagePreference = createServerFn({ method: 'POST' })
  .validator((locale: unknown) => {
    if (!isLocale(locale)) throw new TypeError('Unsupported locale')
    return locale
  })
  .handler(async ({ data }) => {
    const db = createDb(env.HYPERDRIVE)
    const auth = getAuth(env, db)
    let signedIn = false
    try {
      await readRequestSession({ auth, db, headers: getRequest().headers })
      signedIn = true
    } catch (error) {
      if (!(error instanceof AppError && [401, 403].includes(error.status))) throw error
    }
    if (signedIn)
      await auth.api.updateUser({ headers: getRequest().headers, body: { locale: data } })
    return { ok: true }
  })
