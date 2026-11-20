import { expect, type Page, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'
import { chooseOption } from './select.ts'
import { DUMMY_TURNSTILE_TOKEN } from './turnstile.ts'

const password = 'correct-horse-battery-staple'
// 拓宽为 string：衍生项目的语言集合不同，下面与模板语言的比较仍能通过类型检查
const { enabled } = templateConfig.i18n
const locales: readonly string[] = templateConfig.i18n.locales
const defaultLocale: string = templateConfig.i18n.defaultLocale
/** 被提示的语言：配置中第一个非默认语言；没有时为空串，用例跳过 */
const target = (enabled && locales.find((locale) => locale !== defaultLocale)) || ''
const noTarget = '未启用多语言或没有非默认语言，不会出现语言提示'

/** 语言提示条（multilingual-seo 4.2）：水合后挂载，用属性定位，不依赖文案 */
const prompt = (page: Page) => page.locator('[data-language-prompt]')

/** 本页 hreflang 声明的目标语言地址（pathname） */
async function alternatePath(page: Page, locale: string) {
  const href = await page
    .locator(`link[rel="alternate"][hreflang="${locale}"]`)
    .getAttribute('href')
  return new URL(href ?? '').pathname
}

/** 页面开始后累计的布局位移（CLS 各条目之和，不排除有输入的条目以免漏记） */
const layoutShift = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let total = 0
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            total += (entry as unknown as { value: number }).value
        }).observe({ type: 'layout-shift', buffered: true })
        setTimeout(() => resolve(total), 100)
      }),
  )

test('语言提示不进入服务端 HTML，提示与关闭都不产生语言相关的 Set-Cookie', async ({ request }) => {
  test.skip(!target, noTarget)
  for (const path of ['/', '/pricing']) {
    const response = await request.get(path, {
      headers: { 'accept-language': `${target},en;q=0.5` },
    })
    expect(response.status()).toBe(200)
    const html = await response.text()
    expect(html).not.toContain('data-language-prompt')
    expect(html).not.toContain('data-locale-suggestion')
    const cookies = response.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie')
    expect(cookies.map((h) => h.value).join('\n')).not.toMatch(
      /PARAGLIDE_LOCALE|locale-preference/i,
    )
  }
})

test('浏览器语言有已发布版本时水合后出现提示：普通链接、无布局位移，关闭后本浏览器不再出现', async ({
  browser,
  baseURL,
}) => {
  test.skip(!target, noTarget)
  const context = await browser.newContext({ ...(baseURL ? { baseURL } : {}), locale: target })
  const page = await context.newPage()
  try {
    await page.goto('/pricing')
    await expect(page.locator('html')).toHaveAttribute('lang', defaultLocale)
    await page.waitForLoadState('networkidle')
    const before = await layoutShift(page)
    await expect(prompt(page)).toBeVisible({ timeout: 15_000 })
    await expect(prompt(page)).toHaveCSS('position', 'fixed')
    await expect(prompt(page)).toHaveAttribute('lang', target)
    // 进入动画结束后再量：固定定位不推动正文，CLS 增量为 0
    await page.waitForTimeout(300)
    expect(await layoutShift(page)).toBe(before)
    const destination = await alternatePath(page, target)
    const link = prompt(page).getByRole('link')
    await expect(link).toHaveAttribute('href', destination)
    await expect(link).toHaveAttribute('hreflang', target)
    await link.click()
    await expect(page).toHaveURL(new RegExp(`${destination}$`))
    await expect(page.locator('html')).toHaveAttribute('lang', target)
    // 目标语言页面上浏览器首选即当前语言，不再提示
    await page.waitForTimeout(1_800)
    await expect(prompt(page)).toHaveCount(0)

    await page.goto('/pricing')
    await expect(prompt(page)).toBeVisible({ timeout: 15_000 })
    await prompt(page).getByRole('button').click()
    await expect(prompt(page)).toHaveCount(0)
    await page.reload()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1_800)
    await expect(prompt(page)).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('对应语言未发布（只有默认语言的文章）时不提示', async ({ browser, baseURL }) => {
  test.skip(!target, noTarget)
  test.skip(!templateConfig.features.blog, '需要博客')
  test.skip(templateConfig.i18n.untranslated === 'fallback', "项目使用 'fallback'")
  const context = await browser.newContext({ ...(baseURL ? { baseURL } : {}), locale: target })
  const page = await context.newPage()
  try {
    await page.goto('/blog/draft-example')
    await expect(page.locator(`link[rel="alternate"][hreflang="${target}"]`)).toHaveCount(0)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1_800)
    await expect(prompt(page)).toHaveCount(0)
    // 切换器同样只列本页真实存在的版本（桌面左下浮动菜单）
    await page.setViewportSize({ width: 1440, height: 900 })
    const trigger = page.getByRole('button', { name: 'Language', exact: true })
    await expect(trigger).toBeEnabled()
    await trigger.click()
    const items = page.getByRole('menuitem')
    await expect(items).toHaveCount(1)
    await expect(items.first()).toHaveAttribute('aria-current', 'page')
  } finally {
    await context.close()
  }
})

/** 在语言切换菜单中选择一项（菜单项是普通链接） */
async function chooseLanguage(page: Page, label: string, name = 'Language') {
  const trigger = page.getByRole('button', { name, exact: true })
  await expect(trigger).toBeEnabled({ timeout: 30_000 })
  await trigger.click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
}

test('换设备登录后应用区跟随账号语言，营销页继续按 URL，账号设置可再次切换', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  // 本用例针对模板自带的 en / zh 文案（中文界面文字），衍生项目语言不同时跳过
  test.skip(
    !enabled || !locales.includes('zh') || defaultLocale !== 'en',
    '需要启用多语言且配置默认语言 en 与 zh：用例断言的是模板自带的中英文界面文字',
  )
  const email = `i18n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`
  const headers = { origin: baseURL ?? '', 'x-turnstile-token': DUMMY_TURNSTILE_TOKEN }
  const signup = await context.request.post('/api/auth/sign-up/email', {
    headers,
    data: { email, password, name: 'Locale User' },
  })
  expect(signup.status()).toBe(200)
  await page.goto('/app')
  await expect(page.getByText('Personal workspace', { exact: true })).toBeVisible()
  await chooseLanguage(page, '中文')
  await expect(page.getByText('个人空间', { exact: true })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh')

  const other = await browser.newContext({ ...(baseURL ? { baseURL } : {}), locale: 'en-US' })
  const secondPage = await other.newPage()
  try {
    // 新设备已有相反的匿名 Cookie，账号设置仍优先。
    await other.addCookies([{ name: 'PARAGLIDE_LOCALE', value: 'en', url: baseURL ?? '' }])
    const login = await other.request.post('/api/auth/sign-in/email', {
      headers,
      data: { email, password },
    })
    expect(login.status()).toBe(200)
    await secondPage.goto('/app')
    await expect(secondPage.locator('html')).toHaveAttribute('lang', 'zh')
    await expect(secondPage.getByText('个人空间', { exact: true })).toBeVisible()
    await secondPage.goto('/pricing')
    await expect(secondPage.locator('html')).toHaveAttribute('lang', 'en')
    await secondPage.goto('/account')
    await expect(secondPage.getByRole('heading', { name: '账号设置', exact: true })).toBeVisible()
    await expect(
      secondPage.getByRole('combobox', { name: '语言', exact: true }).first(),
    ).toBeEnabled()
    const preferences = secondPage
      .getByRole('heading', { name: '语言与时区', exact: true })
      .locator('..')
    await chooseOption(preferences.getByRole('combobox', { name: '语言', exact: true }), 'en')
    await preferences.getByRole('button', { name: '保存偏好' }).click()
    // 现有账号设置表单保存后，账号和应用首屏均使用英文。
    await expect(secondPage.locator('html')).toHaveAttribute('lang', 'en')
    await secondPage.goto('/app')
    await expect(secondPage.getByText('Personal workspace', { exact: true })).toBeVisible()
  } finally {
    await other.close()
  }
})
