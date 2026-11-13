import { expect, test } from '@playwright/test'
import { chooseOption } from './select.ts'

// 组件预览页（add-ui-design-system D6）：开发环境 wrangler 顶层设 UI_PREVIEW=true，页面可达且不被索引；
// 关闭时的 404 由 smoke.spec.ts（UI_PREVIEW=false）覆盖。
test('component preview renders every section in development', async ({ page }) => {
  const response = await page.goto('/dev/ui')
  expect(response?.status()).toBe(200)
  await expect(page.getByRole('heading', { level: 1, name: 'Component preview' })).toBeVisible()
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow')
  for (const name of [
    'Button',
    'Combobox',
    'Tabs',
    'Dropdown',
    'Command Menu',
    'Toast',
    'Sidebar',
  ]) {
    await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible()
  }
  // 运行时切换预设写入 <html data-preset>
  await chooseOption(page.getByRole('combobox', { name: 'Preset', exact: true }), 'violet')
  await expect(page.locator('html')).toHaveAttribute('data-preset', 'violet')
})

// 分享卡片预览（add-og-images 6.1）：中/英/长标题与默认分享图 × 浅/深，均由真实渲染器输出 1200×630。
test('share card previews render every variant at 1200x630', async ({ page }) => {
  await page.goto('/dev/ui#share-cards')
  const previews = page.locator('img[data-share-card-preview]')
  await expect(previews).toHaveCount(8)
  for (const variant of ['zh', 'en', 'long', 'default'])
    for (const mode of ['light', 'dark']) {
      const image = page.locator(`img[data-share-card-preview="${variant}-${mode}"]`)
      await image.scrollIntoViewIfNeeded()
      await expect
        .poll(
          () => image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth),
          {
            timeout: 30_000,
          },
        )
        .toBe(1200)
      expect(await image.evaluate((node: HTMLImageElement) => node.naturalHeight)).toBe(630)
    }
})
