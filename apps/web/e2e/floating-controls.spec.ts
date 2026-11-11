/// <reference lib="dom" />
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { expect, type Locator, type Page, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'
import { register, simulateClientIp } from './fixtures.ts'
import { stubTurnstile } from './turnstile.ts'

// #46/#65：全局浮动入口属于页面层，任何模态遮罩与面板都应盖过它们。
const evidenceDir = resolve(
  process.env.EVIDENCE_DIR ?? new URL('../../../test-results/evidence', import.meta.url).pathname,
  'prerelease-ui',
)
const themeControl = (page: Page) => page.locator('[data-slot="theme-toggle"].fixed')
const languageControl = (page: Page) =>
  page.locator('div.fixed').filter({
    has: page.getByRole('combobox', { name: 'Language', includeHidden: true }),
  })

async function center(locator: Locator) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  if (!box) throw new Error('Floating control has no bounding box')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function expectHit(target: Locator, point: { x: number; y: number }) {
  await expect
    .poll(() =>
      target.evaluate((element, position) => {
        const hit = document.elementFromPoint(position.x, position.y)
        return hit !== null && (hit === element || element.contains(hit))
      }, point),
    )
    .toBe(true)
}

async function expectPageLayer(control: Locator) {
  await expect(control).toBeVisible()
  expect(
    await control.evaluate((element) => {
      const css = getComputedStyle(element)
      return (
        css.zIndex === css.getPropertyValue('--z-sticky').trim() &&
        Number(css.zIndex) < Number(css.getPropertyValue('--z-overlay'))
      )
    }),
  ).toBe(true)
}

async function screenshot(page: Page, name: string) {
  await mkdir(evidenceDir, { recursive: true })
  await page.screenshot({ path: resolve(evidenceDir, `${name}.png`), animations: 'disabled' })
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${viewport.width}px ${theme}：真实浮动入口低于 Dialog / AlertDialog 遮罩`, async ({
      page,
    }) => {
      test.setTimeout(60_000)
      await page.setViewportSize(viewport)
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' })
      await page.goto('/')
      await expectPageLayer(languageControl(page))
      await expectPageLayer(themeControl(page))
      // 营销页没有模态入口，核对真实 AI 入口采用同一个页面层 token。
      if (templateConfig.marketing.aiEntry.enabled) {
        await expectPageLayer(page.locator('a.fixed').filter({ hasText: 'Ask AI' }))
      }

      await page.goto('/dev/ui')
      await expect(themeControl(page).locator('[data-theme-option="system"]')).toBeEnabled({
        timeout: 30_000,
      })
      await expectPageLayer(languageControl(page))
      await expectPageLayer(themeControl(page))
      const positions = [await center(languageControl(page)), await center(themeControl(page))]
      const overlay = page.locator('body > [data-state="open"][class*="--z-overlay"]')

      const rename = page.locator('#dialog').getByRole('button', { name: 'Rename…' })
      await rename.click()
      const dialog = page.getByRole('dialog', { name: 'Rename project' })
      await expect(dialog).toBeVisible()
      await expect(overlay).toHaveCSS('opacity', '1')
      for (const point of positions) await expectHit(overlay, point)
      await screenshot(page, `floating-dialog-${viewport.width}-${theme}`)
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(rename).toBeFocused()

      const remove = page.locator('#dialog').getByRole('button', { name: 'Delete project' })
      await remove.click()
      const confirmation = page.getByRole('alertdialog')
      await expect(confirmation).toBeVisible()
      await expect(overlay).toHaveCSS('opacity', '1')
      for (const point of positions) await expectHit(overlay, point)
      await screenshot(page, `floating-alert-dialog-${viewport.width}-${theme}`)
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(confirmation).toBeHidden()
      await expect(remove).toBeFocused()

      if (viewport.width === 390) {
        // EmbeddedChat 的真实移动实现是底部 sheet；底部坐标应命中面板，露出的上部命中遮罩。
        await page
          .locator('#business-chat')
          .getByRole('button', { name: 'Open without floating button' })
          .click()
        const sheet = page.locator('[data-embedded-chat="sheet"]')
        await expect(sheet).toBeVisible()
        for (const point of positions) await expectHit(sheet, point)
        await expectHit(page.locator('[data-embedded-chat-overlay]'), { x: 195, y: 16 })
        await screenshot(page, `floating-bottom-sheet-390-${theme}`)
        await page.keyboard.press('Escape')
        await expect(sheet).toBeHidden()
      }
    })
  }
}

test('390px：真实 App 导航抽屉盖住页面，inline 控件不泄漏到遮罩上', async ({ page }) => {
  test.setTimeout(60_000)
  test.skip(templateConfig.ui.appLayout !== 'sidebar', '需要 sidebar 布局')
  await simulateClientIp(page)
  await stubTurnstile(page)
  await register(page, `floating-${Date.now()}@example.com`, 'Floating Controls Tester')
  const home = page.url()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(home)
  await page.waitForLoadState('networkidle')
  await expect(themeControl(page)).toHaveCount(0)
  await expect(languageControl(page)).toHaveCount(0)
  const menu = page.getByRole('button', { name: 'Open navigation' })
  await menu.click()
  const drawer = page.getByRole('dialog', { name: 'Navigation' })
  await expect(drawer).toBeVisible()
  // 原根浮动主题控件的右下位置应由 SidebarSheet 的遮罩接收点击。
  await expectHit(page.locator('[data-sidebar="overlay"]'), { x: 365, y: 815 })
  await expectHit(drawer, await center(drawer.locator('[data-slot="theme-toggle"]')))
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(menu).toBeFocused()
})
