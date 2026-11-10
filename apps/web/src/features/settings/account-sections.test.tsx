import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { baseLocale, overwriteGetLocale } from '../../paraglide/runtime.js'
import type { AccountView } from './account.ts'
import { PreferencesSection } from './account-sections.tsx'
import { ACCOUNT_COPY } from './copy.ts'

const user: AccountView['user'] = {
  id: 'user',
  name: 'User',
  email: 'user@example.com',
  emailVerified: true,
  image: null,
  locale: null,
  timezone: null,
  twoFactorEnabled: false,
}

beforeEach(() => overwriteGetLocale(() => baseLocale))
afterEach(() => overwriteGetLocale(() => baseLocale))

describe('account language preference', () => {
  it.each([
    { locale: 'zh', expected: 'zh' },
    { locale: null, expected: null },
    { locale: 'removed', expected: null },
  ])('renders the selected language before hydration for $locale', ({ locale, expected }) => {
    const html = renderToStaticMarkup(
      <PreferencesSection user={{ ...user, locale }} locales={['en', 'zh']} />,
    )
    const trigger = html.match(/<button[^>]*role="combobox"[^>]*>[\s\S]*?<\/button>/)?.[0]
    expect(html).toContain('for="locale"')
    expect(trigger).toContain('id="locale"')
    expect(trigger).toContain(expected ?? ACCOUNT_COPY.preferences.localeDefault)
  })
})
