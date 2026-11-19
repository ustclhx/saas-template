import { describe, expect, it, vi } from 'vitest'
import { templateConfig } from '../../server/template-config.ts'
import { assertSeoPages, validateSeoPages } from './linking.ts'
import type { SeoPage } from './metadata.ts'
import { staticPage } from './metadata.ts'
import { publicPages } from './pages.ts'

// 项目注册入口返回的页面与模板清单合并（tasks.md 1.4）
vi.mock('./pages.project.ts', () => ({
  projectPages: ({ locale }: { locale: string }): SeoPage[] => [
    {
      path: '/tarot',
      locale,
      title: 'Tarot',
      description: 'Tarot cards',
      titleMain: 'Tarot',
      parent: '/',
    },
    {
      path: '/tarot/the-fool',
      locale,
      title: 'The Fool',
      description: 'The Fool card',
      titleMain: 'The Fool',
      parent: '/tarot',
      group: '/tarot',
    },
  ],
}))

const en = templateConfig.i18n.defaultLocale
const page = (path: string, fields: Partial<SeoPage> = {}): SeoPage => ({
  path,
  locale: en,
  title: path,
  description: path,
  titleMain: path,
  ...(path !== '/' && { parent: '/' }),
  ...fields,
})
const home = page('/')

const content = {
  posts: [
    {
      slug: 'hello',
      locale: en,
      title: 'Hello',
      summary: 'Hello summary',
      date: '2026-01-01',
      tags: ['intro'],
      draft: false,
      anchor_short: 'Hi',
      related: ['/legal/terms'],
    },
  ],
  legal: [{ slug: 'terms', locale: en, title: 'Terms', description: 'Terms of service' }],
  docs: [],
  guides: [
    {
      slug: 'free',
      locale: en,
      title: 'Is it free?',
      answer_summary: 'Yes.',
      draft: false,
      parent: '/blog',
    },
  ],
}
const config = {
  ...templateConfig,
  marketing: { ...templateConfig.marketing, enabled: true },
  features: { ...templateConfig.features, blog: true, guides: true, docs: false },
}

describe('页面层级与主词声明（1.2–1.4）', () => {
  const pages = publicPages(content, new Date('2026-10-01'), config).filter(
    (page) => page.locale === en,
  )
  const find = (path: string) => pages.find((page) => page.path === path)

  it('模板静态页声明上级与主词，首页没有上级', () => {
    expect(staticPage('/', en)).toMatchObject({ titleMain: templateConfig.app.name })
    expect(staticPage('/', en).parent).toBeUndefined()
    for (const path of ['/pricing', '/blog', '/guides', '/docs', '/newsletter', '/waitlist']) {
      const declared = staticPage(path, 'zh')
      expect(declared.parent).toBe('/')
      expect(declared.titleMain).toBeTruthy()
    }
  })

  it('内容集合按目录推导默认 parent，主词取标题，frontmatter 可覆盖', () => {
    expect(find('/blog/hello')).toMatchObject({
      parent: '/blog',
      titleMain: 'Hello',
      anchorShort: 'Hi',
      related: ['/legal/terms'],
      sourceLocale: en,
    })
    expect(find('/legal/terms')).toMatchObject({ parent: '/', titleMain: 'Terms' })
    expect(find('/legal/terms')?.related).toBeUndefined()
    // 答案页默认上级是 /guides，这里由 frontmatter 改为 /blog
    expect(find('/guides/free')).toMatchObject({ parent: '/blog', titleMain: 'Is it free?' })
    expect(find('/blog/tags/intro')).toMatchObject({ parent: '/blog', anchorShort: 'intro' })
  })

  it('pages.project.ts 注册的页面按语言并入清单，整体通过校验', () => {
    const all = publicPages(content, new Date('2026-10-01'), config)
    const locales = config.i18n.enabled ? config.i18n.locales : [en]
    for (const locale of locales)
      expect(
        all.filter((page) => page.locale === locale && page.path.startsWith('/tarot')),
      ).toHaveLength(2)
    expect(validateSeoPages(all)).toEqual({ errors: [], warnings: [] })
  })
})

describe('元数据静态校验（1.5）', () => {
  it('同一语言地址重复时失败；不同语言同一 path 不算重复', () => {
    const { errors } = validateSeoPages([
      home,
      page('/a'),
      page('/a', { title: 'Again' }),
      { ...page('/a'), locale: 'zh' },
      { ...home, locale: 'zh' },
    ])
    expect(errors).toEqual([expect.stringMatching(/^\/a: 同一语言中地址重复/)])
  })

  it('缺少 parent 或 titleMain 时失败并给出页面地址', () => {
    const { errors } = validateSeoPages([
      home,
      { ...page('/tarot/the-fool'), parent: undefined },
      page('/b', { titleMain: ' ' }),
    ])
    expect(errors).toEqual([
      expect.stringMatching(/^\/tarot\/the-fool: 缺少 parent/),
      '/b: 缺少 titleMain（主词）',
    ])
  })

  it('parent、group、related 指向不存在的页面时失败，指出页面与目标地址', () => {
    const { errors } = validateSeoPages([
      home,
      page('/tarot/the-fool', {
        parent: '/tarot',
        group: '/tarot/major',
        related: ['/numbers/1'],
      }),
    ])
    expect(errors).toEqual([
      expect.stringMatching(/^\/tarot\/the-fool: parent 指向不存在的页面 \/tarot/),
      expect.stringMatching(/^\/tarot\/the-fool: group 指向不存在的页面 \/tarot\/major/),
      expect.stringMatching(/^\/tarot\/the-fool: related 指向不存在的页面 \/numbers\/1/),
    ])
  })

  it('目标存在但不可索引时失败', () => {
    const { errors } = validateSeoPages([
      home,
      page('/hidden', { indexable: false, parent: undefined, titleMain: undefined }),
      page('/a', { related: ['/hidden'] }),
      page('/b', { parent: '/hidden' }),
      page('/c', { group: '/hidden' }),
    ])
    expect(errors).toEqual([
      '/a: related 指向不可索引的页面 /hidden',
      '/b: parent 指向不可索引的页面 /hidden',
      '/c: group 指向不可索引的页面 /hidden',
    ])
  })

  it('parent 指向自身、成环与首页声明 parent 时失败', () => {
    const { errors } = validateSeoPages([
      { ...home, parent: '/x' },
      page('/self', { parent: '/self' }),
      page('/x', { parent: '/y' }),
      page('/y', { parent: '/x' }),
    ])
    expect(errors).toEqual([
      '/: 首页不能声明 parent',
      '/self: parent 不能指向自身',
      '/x: parent 链成环',
      '/y: parent 链成环',
    ])
  })

  it('回退页与不可索引页不检查自身声明，地址按语言加前缀', () => {
    const zh = (path: string, fields: Partial<SeoPage> = {}) => ({
      ...page(path, fields),
      locale: 'zh',
    })
    const report = validateSeoPages([
      zh('/'),
      zh('/fallback', { sourceLocale: en, parent: '/missing' }),
      zh('/private', { indexable: false, parent: undefined }),
      zh('/broken', { parent: '/missing' }),
    ])
    expect(report.errors).toEqual([
      expect.stringMatching(/^\/zh\/broken: parent 指向不存在的页面 \/zh\/missing/),
    ])
  })

  it('同一语言主词重复只警告并列出两页', () => {
    const report = validateSeoPages([
      home,
      page('/a', { titleMain: 'Tarot' }),
      page('/b', { titleMain: 'Tarot' }),
      { ...page('/c', { titleMain: 'Tarot' }), locale: 'zh' },
      { ...home, locale: 'zh' },
    ])
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([`主词「Tarot」在 ${en} 中重复：/a、/b`])
    const warn = vi.fn()
    expect(() => assertSeoPages([home, page('/a', { titleMain: '/' })], warn)).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[seo] 主词「/」'))
    expect(() => assertSeoPages([home, page('/a', { parent: '/nope' })], warn)).toThrow(
      /公开页面元数据校验失败（1 项）：\n\/a: parent 指向不存在的页面 \/nope/,
    )
  })
})
