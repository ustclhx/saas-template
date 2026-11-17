import { expect, type Page, test } from '@playwright/test'
import { chooseOption } from './select.ts'
import { DUMMY_TURNSTILE_TOKEN } from './turnstile.ts'

const password = 'correct-horse-battery-staple'

/** 水合完成的信号：浮动语言选择器在水合后的 effect 中才可用 */
const hydrated = (page: Page) =>
  expect(page.getByRole('combobox', { name: 'Language', exact: true })).toBeEnabled({
    timeout: 30_000,
  })

/** 挂起页面脚本请求，模拟营销页首帧后、水合前的时间窗；返回放行函数 */
async function holdScripts(page: Page) {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() === 'script') await gate
    await route.fallback().catch(() => {})
  })
  return async () => {
    release()
    await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
}

const preferenceCookie = async (page: Page) =>
  (await page.context().cookies()).find((cookie) => cookie.name === 'locale-preference')?.value

test('浏览器语言偏好只建议不跳转，手动选择和关闭建议会记住偏好', async ({ browser, baseURL }) => {
  // 建议由首帧前脚本按 navigator.languages 决定（suggestion.ts），locale 同时设置它与 Accept-Language
  const context = await browser.newContext({ ...(baseURL ? { baseURL } : {}), locale: 'zh-CN' })
  const page = await context.newPage()
  try {
    await page.goto('/pricing')
    await expect(page).toHaveURL(/\/pricing$/)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    const banner = page.getByRole('complementary', { name: 'Language suggestion' })
    await expect(banner).toBeVisible()
    await hydrated(page)
    await banner.getByRole('link', { name: 'Switch language' }).click()
    await expect(page).toHaveURL(/\/zh\/pricing$/)
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
    expect(await preferenceCookie(page)).toBe('zh')
    // Cookie 记住选择，但直接访问默认语言 URL 仍显示默认语言。
    await page.goto('/pricing')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(banner).toHaveCount(0)
    await context.clearCookies()
    await page.reload()
    await expect(banner).toBeVisible()
    await hydrated(page)
    await banner.getByRole('button', { name: 'Keep current language' }).click()
    await expect(banner).toBeHidden()
    await page.reload()
    await expect(banner).toHaveCount(0)
  } finally {
    await context.close()
  }
})

test('横幅首帧即可操作：水合前点击切换与保留当前语言同样生效', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ...(baseURL ? { baseURL } : {}), locale: 'zh-CN' })
  const page = await context.newPage()
  const banner = page.getByRole('complementary', { name: 'Language suggestion' })
  const language = page.getByRole('combobox', { name: 'Language', exact: true })
  try {
    // 保留当前语言：首帧脚本的委托监听写入 Cookie 并隐藏横幅
    let release = await holdScripts(page)
    await page.goto('/pricing', { waitUntil: 'commit' })
    await expect(banner).toBeVisible()
    await expect(language).toBeDisabled()
    await banner.getByRole('button', { name: 'Keep current language' }).click()
    await expect(banner).toBeHidden()
    expect(await preferenceCookie(page)).toBe('en')
    await release()
    await page.reload()
    await expect(banner).toHaveCount(0)

    // 切换：真实链接直接导航，委托监听同时记住选择
    await context.clearCookies()
    release = await holdScripts(page)
    await page.goto('/pricing?utm_source=e2e', { waitUntil: 'commit' })
    await expect(banner).toBeVisible()
    await expect(language).toBeDisabled()
    await banner.getByRole('link', { name: 'Switch language' }).click()
    // 查询参数（如 UTM）随导航保留
    await expect(page).toHaveURL(/\/zh\/pricing\?utm_source=e2e$/)
    await release()
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh')
    expect(await preferenceCookie(page)).toBe('zh')
  } finally {
    await context.close()
  }
})

test('换设备登录后应用区跟随账号语言，营销页继续按 URL，账号设置可再次切换', async ({
  page,
  context,
  browser,
  baseURL,
}) => {
  const email = `i18n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`
  const headers = { origin: baseURL ?? '', 'x-turnstile-token': DUMMY_TURNSTILE_TOKEN }
  const signup = await context.request.post('/api/auth/sign-up/email', {
    headers,
    data: { email, password, name: 'Locale User' },
  })
  expect(signup.status()).toBe(200)
  await page.goto('/app')
  await expect(page.getByText('Personal workspace', { exact: true })).toBeVisible()
  await chooseOption(page.getByRole('combobox', { name: 'Language', exact: true }), '中文')
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
