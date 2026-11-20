import { expect, test } from '@playwright/test'
import templateConfig from '../../../template.config.ts'

const { locales, defaultLocale } = templateConfig.i18n
const publicPaths = ['/', '/pricing', '/legal/privacy', '/legal/terms', '/legal/refund']
if (templateConfig.features.blog)
  publicPaths.push(
    '/blog',
    '/blog/welcome',
    '/blog/writing-posts',
    '/blog/tags/guide',
    '/blog/tags/announcement',
  )
if (templateConfig.features.docs)
  publicPaths.push('/docs', '/docs/getting-started', '/docs/content', '/docs/configuration')
if (templateConfig.features.waitlist) publicPaths.push('/waitlist')
if (templateConfig.features.newsletter) publicPaths.push('/newsletter')

for (const locale of locales) {
  test(`公开路由 head 与唯一 canonical（${locale}）`, async ({ page }) => {
    const titles = new Set<string>()
    const canonicals = new Set<string>()
    for (const path of publicPaths) {
      const prefix = locale === defaultLocale ? '' : `/${locale}`
      const response = await page.goto(`${prefix}${path === '/' ? '' : path}` || '/')
      expect(response?.status(), path).toBe(200)
      const title = await page.title()
      expect(title, path).toContain(templateConfig.app.name)
      expect(titles.has(title), path).toBe(false)
      titles.add(title)
      const canonical = await page.locator('link[rel="canonical"]').getAttribute('href')
      expect(canonical, path).toBeTruthy()
      expect(canonicals.has(canonical ?? ''), path).toBe(false)
      canonicals.add(canonical ?? '')
      expect(new URL(canonical ?? '').pathname).toBe(`${prefix}${path === '/' ? '' : path}` || '/')
      for (const name of ['description', 'twitter:card', 'twitter:image'])
        await expect(page.locator(`meta[name="${name}"]`)).toHaveAttribute('content', /\S/)
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
        'content',
        canonical ?? '',
      )
      await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
        'content',
        /^https?:\/\//,
      )
      await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveCount(1)
      await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0)
    }
    // 客户端导航也必须更换 canonical 与标题。
    await page.goto(locale === defaultLocale ? '/' : `/${locale}`)
    await page
      .locator(`header a[href="${locale === defaultLocale ? '' : `/${locale}`}/pricing"]`)
      .click()
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/pricing$/)
  })
}

// 只有默认语言版本的文章（multilingual-seo ML-04）：e2e 使用 vite dev，草稿示例可访问且只有英文版本。
// 默认 `i18n.untranslated: 'hide'`：其他语言地址 404，原文 canonical 指向自身、hreflang 不列出缺少译文的语言。
// 'fallback' 模式（回退页 canonical 指向原语言）与站点地图过滤由单元测试覆盖（seo.test.tsx）。
const otherLocale = locales.find((locale) => locale !== defaultLocale)
test('缺少译文的文章：其他语言 404，原文 hreflang 只列真实译文', async ({ page }) => {
  test.skip(!templateConfig.features.blog || !otherLocale, '需要博客与至少两种语言')
  test.skip(templateConfig.i18n.untranslated === 'fallback', "项目使用 'fallback'，由单元测试覆盖")
  expect((await page.goto(`/${otherLocale}/blog/draft-example`))?.status()).toBe(404)
  const response = await page.goto('/blog/draft-example')
  expect(response?.status()).toBe(200)
  await expect(page.locator('h1')).toHaveText('Draft example')
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href')
  expect(new URL(canonical ?? '').pathname).toBe('/blog/draft-example')
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', canonical ?? '')
  await expect(page.locator(`link[rel="alternate"][hreflang="${otherLocale}"]`)).toHaveCount(0)
  await expect(page.locator(`link[rel="alternate"][hreflang="${defaultLocale}"]`)).toHaveAttribute(
    'href',
    canonical ?? '',
  )
  await expect(page.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute(
    'href',
    canonical ?? '',
  )
  // 有译文的文章照常互相关联，canonical 指向自身
  await page.goto(`/${otherLocale}/blog/welcome`)
  await expect(page.locator(`link[rel="alternate"][hreflang="${otherLocale}"]`)).toHaveCount(1)
  expect(
    new URL((await page.locator('link[rel="canonical"]').getAttribute('href')) ?? '').pathname,
  ).toBe(`/${otherLocale}/blog/welcome`)
})

// 面包屑与内链区块（seo-internal-linking 3.1–3.3）：真实 <a href>、与面包屑一致的 BreadcrumbList、
// 声明了 related 的文章才有相关区块，hub 列表链接到全部文章。
for (const locale of locales) {
  test(`面包屑、BreadcrumbList 与相关区块（${locale}）`, async ({ page }) => {
    test.skip(!templateConfig.features.blog, '需要博客')
    const prefix = locale === defaultLocale ? '' : `/${locale}`
    await page.goto(`${prefix}/blog/welcome`)
    const crumbs = page.locator('nav[data-slot="breadcrumb"][data-link-zone="nav"]')
    await expect(crumbs.locator('a')).toHaveCount(2)
    const links = await crumbs
      .locator('a')
      .evaluateAll((anchors) =>
        anchors.map((a) => ({ href: a.getAttribute('href'), text: a.textContent?.trim() })),
      )
    expect(links.map((link) => link.href)).toEqual([prefix || '/', `${prefix}/blog`])
    await expect(crumbs.locator('[aria-current="page"]')).toHaveText(
      (await page.locator('h1').textContent()) ?? '',
    )
    // 文章顶部不再有「← 返回」链接
    await expect(page.locator('article a', { hasText: '←' })).toHaveCount(0)
    const scripts = await page
      .locator('script[type="application/ld+json"]')
      .evaluateAll((nodes) => nodes.map((node) => JSON.parse(node.textContent ?? '{}')))
    const list = scripts.find((data) => data['@type'] === 'BreadcrumbList')
    expect(list.itemListElement.map((item: { name: string }) => item.name)).toEqual([
      ...links.map((link) => link.text),
      await page.locator('h1').textContent(),
    ])
    expect(
      list.itemListElement
        .slice(0, -1)
        .map((item: { item: string }) => new URL(item.item).pathname),
    ).toEqual(links.map((link) => link.href))
    // welcome 声明了 related：相关区块在正文之后，锚文本为目标标题
    const related = page.locator('section[data-link-zone="related"]')
    await expect(related.locator(`a[href="${prefix}/blog/writing-posts"]`)).toHaveCount(1)
    // writing-posts 没有声明 related，也不属于任何 group：没有相关与同组区块
    await page.goto(`${prefix}/blog/writing-posts`)
    await expect(page.locator('[data-link-zone="related"]')).toHaveCount(0)
    await expect(
      page.locator('[data-link-zone="siblings"], [data-link-zone="series"]'),
    ).toHaveCount(0)
    // hub：博客列表链接到文章，单页时没有分页
    await page.goto(`${prefix}/blog`)
    await expect(page.locator(`main a[href="${prefix}/blog/welcome"]`)).toHaveCount(1)
    await expect(page.locator('nav[data-slot="pagination"]')).toHaveCount(0)
    expect((await page.goto(`${prefix}/blog/page/2`))?.status()).toBe(404)
  })
}

test('地图发布过滤、robots 与 构建期 PNG 输出', async ({ request }) => {
  const response = await request.get('/sitemap.xml')
  expect(response.status()).toBe(200)
  const xml = await response.text()
  for (const locale of locales) {
    const prefix = locale === defaultLocale ? '' : `/${locale}`
    if (templateConfig.features.blog) expect(xml).toContain(`${prefix}/blog/welcome</loc>`)
  }
  for (const path of ['/app', '/admin', '/api', 'draft-example', 'scheduled-example'])
    expect(xml).not.toContain(path)
  const rules = await (await request.get('/robots.txt')).text()
  for (const path of ['/app', '/admin', '/api']) expect(rules).toContain(`Disallow: ${path}`)
  for (const path of ['/legal/terms', '/zh/legal/terms']) {
    const image = await request.get(
      `/og/${path.startsWith('/zh/') ? 'zh' : 'en'}${path.replace(/^\/zh/, '')}.png`,
    )
    expect(image.status()).toBe(200)
    expect(image.headers()['content-type']).toBe('image/png')
    const data = await image.body()
    expect([...data.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(data.readUInt32BE(16)).toBe(1200)
    expect(data.readUInt32BE(20)).toBe(630)
  }
  expect((await request.get('/og/en/blog/draft-example.png')).status()).toBe(404)
})
