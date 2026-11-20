import { describe, expect, it, vi } from 'vitest'
import { templateConfig } from '../../server/template-config.ts'
import { assertSeoPages, validateSeoPages } from './linking.ts'
import type { SeoPage } from './metadata.ts'
import { localizedPath, sameSiteLocales, staticPage } from './metadata.ts'
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
// 另一种语言取项目配置中的非默认语言（衍生项目不一定有 zh，默认语言也不一定是 en）
const other = templateConfig.i18n.locales.find((locale) => locale !== en) ?? `${en}-x`
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
      const declared = staticPage(path, other)
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
      { ...page('/a'), locale: other },
      { ...home, locale: other },
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

  it('回退页与不可索引页不检查自身声明，地址按语言加前缀', ({ skip }) => {
    // 跨站同文页会各自索引，只有同站的非默认语言才能构造回退页。
    const locale = templateConfig.i18n.enabled
      ? templateConfig.i18n.locales.find((locale) => locale !== en && sameSiteLocales(locale, en))
      : undefined
    if (!locale) return skip()

    const translated = (path: string, fields: Partial<SeoPage> = {}) => ({
      ...page(path, fields),
      locale,
    })
    const pages = [
      translated('/'),
      translated('/fallback', { sourceLocale: en, parent: '/missing' }),
      translated('/private', { indexable: false, parent: undefined }),
      translated('/broken', { parent: '/missing' }),
    ]
    const broken = expect.stringContaining(
      `${localizedPath('/broken', locale)}: parent 指向不存在的页面 ${localizedPath('/missing', locale)}（`,
    )
    expect(validateSeoPages(pages, { untranslated: 'fallback' }).errors).toEqual([broken])
    // 'hide'（默认）下回退页不发布：清单中出现回退页即构建失败
    expect(validateSeoPages(pages, { untranslated: 'hide' }).errors).toEqual([
      broken,
      expect.stringContaining(`${localizedPath('/fallback', locale)}: 缺少译文的回退页`),
    ])
  })

  it('同一语言主词重复只警告并列出两页', () => {
    const report = validateSeoPages([
      home,
      page('/a', { titleMain: 'Tarot' }),
      page('/b', { titleMain: 'Tarot' }),
      { ...page('/c', { titleMain: 'Tarot' }), locale: other },
      { ...home, locale: other },
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

// 本地化 slug（openspec multilingual-seo 3.2）：英文 /four-pillars 与韩语 /만세력 互为语言版本
describe.runIf(templateConfig.i18n.enabled)('alternates 静态校验', () => {
  const options = { locales: [en, 'ko'], untranslated: 'hide' as const }
  const ko = (path: string, fields: Partial<SeoPage> = {}) => ({
    ...page(path, fields),
    locale: 'ko',
  })
  const pillars = page('/four-pillars', { alternates: { ko: '/만세력' } })
  const manse = ko('/만세력', { alternates: { [en]: '/four-pillars' } })
  const base = [home, ko('/')]

  it('双向声明且语言合法时通过', () => {
    expect(validateSeoPages([...base, pillars, manse], options).errors).toEqual([])
    // alternates 可以包含自身（与本页地址一致）
    const withSelf = { ...pillars, alternates: { [en]: '/four-pillars', ko: '/만세력' } }
    expect(validateSeoPages([...base, withSelf, manse], options).errors).toEqual([])
  })

  it('键不是已配置语言、目标缺失、未反向声明或组不一致时失败', () => {
    const unknown = page('/a', { alternates: { fr: '/a-fr' } })
    expect(validateSeoPages([...base, unknown], options).errors).toEqual([
      '/a: alternates 的键 fr 不是已配置的语言（i18n.locales）',
    ])
    expect(validateSeoPages([...base, pillars], options).errors).toEqual([
      `/four-pillars: alternates.ko 指向不存在的页面 ${localizedPath('/만세력', 'ko')}`,
    ])
    expect(validateSeoPages([...base, pillars, ko('/만세력')], options).errors).toEqual([
      `/four-pillars: alternates.ko 指向的 ${localizedPath('/만세력', 'ko')} 没有反向声明 ${en}=/four-pillars`,
    ])
    const noindex = ko('/만세력', { alternates: { [en]: '/four-pillars' }, indexable: false })
    expect(validateSeoPages([...base, pillars, noindex], options).errors).toEqual([
      `/four-pillars: alternates.ko 指向不可索引的页面 ${localizedPath('/만세력', 'ko')}`,
    ])
    const self = page('/b', { alternates: { [en]: '/c' } })
    expect(validateSeoPages([...base, self], options).errors).toEqual([
      `/b: alternates.${en} 必须是本页地址 /b`,
    ])
  })

  it('各成员声明的语言版本组不一致时失败', () => {
    const three = { ...options, locales: [en, 'ko', 'ja'] }
    const all = page('/four-pillars', { alternates: { ko: '/만세력', ja: '/shichu' } })
    const ja = {
      ...page('/shichu', { alternates: { [en]: '/four-pillars', ko: '/만세력' } }),
      locale: 'ja',
    }
    const errors = validateSeoPages(
      [...base, { ...home, locale: 'ja' }, all, manse, ja],
      three,
    ).errors
    expect(errors).toContainEqual(
      expect.stringContaining(
        `/four-pillars: 与 ${localizedPath('/만세력', 'ko')} 声明的语言版本不一致`,
      ),
    )
  })

  it('同路径的其他语言页面未声明 alternates 时失败（hreflang 无法互指）', () => {
    const errors = validateSeoPages([...base, pillars, manse, ko('/four-pillars')], options).errors
    expect(errors).toEqual([
      `${localizedPath('/four-pillars', 'ko')}: 同路径的 /four-pillars 声明了 alternates，本页也需声明`,
    ])
  })
})
