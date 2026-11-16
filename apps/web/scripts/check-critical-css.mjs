// 关键样式视觉核对（openspec add-marketing-critical-path 4.1，验收用，不在 pnpm build 中运行）：
// 对预渲染页分别以「只有内联关键样式」（拦截完整样式表）和「完整样式」渲染，阻止水合脚本使两次都停在预渲染 DOM，
// 在手机与桌面宽度、浅色与深色下整页截图并逐字节比较。需要先 `pnpm build` 并启动 `vite preview`。
// 用法：node scripts/check-critical-css.mjs <base-url> [输出目录] [路径,…]
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const [base = 'http://localhost:3000', out = 'test-results/critical-css', list] =
  process.argv.slice(2)
const paths = list ? list.split(',') : ['/', '/zh', '/blog', '/blog/welcome', '/legal/privacy']
const viewports = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
]
const schemes = ['light', 'dark']

async function shot(browser, url, viewport, colorScheme, fullCss) {
  const context = await browser.newContext({ viewport, colorScheme, reducedMotion: 'reduce' })
  const page = await context.newPage()
  // 两次都不水合：比较的只是样式
  await page.route(/\/assets\/.*\.js$/, (route) => route.abort())
  if (!fullCss) await page.route(/\/assets\/.*\.css$/, (route) => route.abort())
  const sheets = []
  page.on('requestfinished', (request) => {
    if (request.url().endsWith('.css')) sheets.push(request.url())
  })
  await page.goto(url, { waitUntil: 'load' })
  // 加载器在首帧后追加样式表：等它完成，再等字体
  if (fullCss)
    await page.waitForFunction(() =>
      [...document.styleSheets].some((sheet) => sheet.href?.includes('/assets/')),
    )
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
  const image = await page.screenshot({ fullPage: true, animations: 'disabled' })
  await context.close()
  return { image, sheets }
}

mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
const failures = []
let compared = 0
for (const path of paths)
  for (const viewport of viewports)
    for (const scheme of schemes) {
      const url = new URL(path, base).href
      const critical = await shot(browser, url, viewport, scheme, false)
      const full = await shot(browser, url, viewport, scheme, true)
      if (full.sheets.length === 0)
        failures.push(`${path} ${viewport.name} ${scheme}: 完整样式表未加载`)
      const name = `${path.replace(/\W+/g, '_') || 'home'}-${viewport.name}-${scheme}`
      compared += 1
      if (!critical.image.equals(full.image)) {
        writeFileSync(join(out, `${name}.critical.png`), critical.image)
        writeFileSync(join(out, `${name}.full.png`), full.image)
        failures.push(`${path} ${viewport.name} ${scheme}: 关键样式与完整样式截图不一致`)
      }
    }
await browser.close()
console.log(`critical-css 视觉核对：${compared} 组，${failures.length} 组不一致`)
for (const failure of failures) console.error(`  - ${failure}`)
if (failures.length) process.exitCode = 1
