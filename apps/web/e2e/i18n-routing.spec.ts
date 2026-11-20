import { expect, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'

// 语言路由（openspec add-marketing-i18n-seo tasks.md 1.1，multilingual-seo 2.2/2.4）：默认语言无前缀、
// 其他配置语言加小写前缀、未配置的前缀 404；应用区不加语言前缀；公开页不按请求头或 Cookie 跳转。
const { defaultLocale } = templateConfig.i18n
const locales: readonly string[] = templateConfig.i18n.locales
const otherLocales = locales.filter((locale) => locale !== defaultLocale)
const unconfigured = ['fr', 'de', 'ja', 'es'].find((locale) => !locales.includes(locale))

test('默认语言使用无前缀地址，带默认语言前缀的地址 301 到无前缀地址', async ({ page, request }) => {
  await page.goto('/pricing')
  await expect(page.locator('html')).toHaveAttribute('lang', defaultLocale)
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr')
  await expect(page).toHaveURL(/\/pricing$/)

  for (const [from, to] of [
    [`/${defaultLocale}`, '/'],
    [`/${defaultLocale}/pricing`, '/pricing'],
    [`/${defaultLocale.toUpperCase()}/pricing?ref=e2e`, '/pricing?ref=e2e'],
  ] as const) {
    // 只看路径：有无 Sec-Fetch-Dest 都跳转
    for (const headers of [{ 'Sec-Fetch-Dest': 'document' }, {}]) {
      const response = await request.get(from, { maxRedirects: 0, headers })
      expect(response.status(), from).toBe(301)
      const location = new URL(response.headers().location ?? '', 'http://localhost')
      expect(`${location.pathname}${location.search}`).toBe(to)
    }
  }
})

test('大小写不同的语言前缀 301 到小写前缀', async ({ request }) => {
  test.skip(otherLocales.length === 0, '没有非默认语言')
  for (const locale of otherLocales) {
    const prefix = locale.toLowerCase()
    const response = await request.get(`/${prefix.toUpperCase()}/pricing`, { maxRedirects: 0 })
    expect(response.status()).toBe(301)
    expect(response.headers().location).toBe(`/${prefix}/pricing`)
  }
})

test('公开页在不同 Accept-Language 与 Cookie 下状态、Location 与 html lang 一致，且不写语言 Cookie', async ({
  request,
}) => {
  const other = otherLocales[0]
  const paths = ['/', '/pricing', ...(other ? [`/${other.toLowerCase()}`] : [])]
  const variants: Record<string, string>[] = [
    { 'Accept-Language': 'zh-CN,zh;q=0.9' },
    { 'Accept-Language': 'en-US,en;q=0.9' },
    { 'Accept-Language': 'en-US', Cookie: `PARAGLIDE_LOCALE=${other ?? defaultLocale}` },
    { 'Accept-Language': 'zh-CN', Cookie: `PARAGLIDE_LOCALE=${defaultLocale}` },
  ]
  for (const path of paths) {
    const results = []
    for (const headers of variants) {
      const response = await request.get(path, {
        maxRedirects: 0,
        headers: { 'Sec-Fetch-Dest': 'document', ...headers },
      })
      const setCookie = response
        .headersArray()
        .filter(({ name }) => name.toLowerCase() === 'set-cookie')
        .map(({ value }) => value)
      expect(
        setCookie.filter((value) => /locale|lang|paraglide/i.test(value)),
        path,
      ).toEqual([])
      const lang = (await response.text()).match(/<html[^>]*\slang="([^"]+)"/)?.[1]
      results.push({ status: response.status(), location: response.headers().location, lang })
    }
    const expectedLang = path === '/' || path === '/pricing' ? defaultLocale : other
    for (const result of results)
      expect(result, path).toEqual({ status: 200, location: undefined, lang: expectedLang })
  }
})

for (const locale of otherLocales) {
  test(`其他配置语言 /${locale}/... 以该语言显示`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const home = await page.goto(`/${locale}`)
    expect(home?.status()).toBe(200)
    await expect(page.locator('html')).toHaveAttribute('lang', locale)

    const pricing = await page.goto(`/${locale}/pricing`)
    expect(pricing?.status()).toBe(200)
    await expect(page.locator('html')).toHaveAttribute('lang', locale)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // 水合后地址不变（客户端路由同样去掉 / 加回语言前缀）
    await expect(page).toHaveURL(new RegExp(`/${locale}/pricing$`))
    expect(errors).toEqual([])
  })
}

test('未配置的语言前缀返回 404', async ({ request }) => {
  test.skip(!unconfigured, 'fr、de、ja、es 均已配置，没有可测的未配置前缀')
  for (const path of [`/${unconfigured}`, `/${unconfigured}/pricing`]) {
    expect((await request.get(path)).status(), path).toBe(404)
  }
})

test('应用区不加语言前缀：带前缀访问返回 404', async ({ request }) => {
  for (const locale of locales) {
    for (const path of ['/app', '/account', '/admin', '/api/health']) {
      const response = await request.get(`/${locale}${path}`, { maxRedirects: 0 })
      expect(response.status(), `/${locale}${path}`).toBe(404)
    }
  }
  expect((await request.get('/api/health')).status()).toBe(200)
})
