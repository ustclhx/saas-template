import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@inlang/paraglide-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  activeLocales,
  findMissingMessages,
  formatMissingMessages,
  paraglideOptions,
  writeInlangProject,
} from './i18n-project.ts'

const i18n = { locales: ['en', 'zh'], defaultLocale: 'en' }
let root: string

function writeMessages(locale: string, feature: string, messages: Record<string, string>) {
  mkdirSync(join(root, 'messages', locale), { recursive: true })
  writeFileSync(join(root, 'messages', locale, `${feature}.json`), JSON.stringify(messages))
}

// 临时的 apps/web 结构：中文 common.json 删掉了一条文案
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'saas-i18n-'))
  symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(root, 'node_modules'))
  writeMessages('en', 'common', { common_save: 'Save', common_cancel: 'Cancel' })
  writeMessages('zh', 'common', { common_save: '保存' })
  writeMessages('en', 'pricing', { pricing_title: 'Pricing' })
  writeMessages('zh', 'pricing', { pricing_title: '定价' })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('文案回退与缺失检查（tasks.md 1.3）', () => {
  it('缺失检查以默认语言为准列出缺失项', () => {
    const missing = findMissingMessages(i18n, root)
    expect(missing).toEqual([{ locale: 'zh', feature: 'common', key: 'common_cancel' }])
    expect(formatMissingMessages(missing)).toContain('zh: common_cancel (messages/zh/common.json)')
    expect(formatMissingMessages([])).toBeNull()
  })

  it('按功能拆分的文案文件编译后，缺失的中文文案回退到默认语言文本而不是键名', async () => {
    writeInlangProject(i18n, root)
    await compile({ ...paraglideOptions([], root), emitTsDeclarations: false })
    const { m } = (await import(join(root, 'src/paraglide/messages.js'))) as {
      m: Record<string, (inputs?: object, options?: { locale: string }) => string>
    }
    expect(m.common_save?.({}, { locale: 'zh' })).toBe('保存')
    expect(m.pricing_title?.({}, { locale: 'zh' })).toBe('定价')
    expect(m.common_cancel?.({}, { locale: 'zh' })).toBe('Cancel')
  })
})

it('关闭 i18n 后真实编译仅保留默认中文，账号 Cookie 和语言 URL 不改变语言', async () => {
  const singleRoot = mkdtempSync(join(tmpdir(), 'saas-i18n-single-'))
  try {
    symlinkSync(
      new URL('../node_modules', import.meta.url).pathname,
      join(singleRoot, 'node_modules'),
    )
    for (const [locale, text] of [
      ['en', 'Save'],
      ['zh', '保存'],
    ] as const) {
      mkdirSync(join(singleRoot, 'messages', locale), { recursive: true })
      writeFileSync(
        join(singleRoot, 'messages', locale, 'common.json'),
        JSON.stringify({ common_save: text }),
      )
    }
    const single = { ...i18n, enabled: false, defaultLocale: 'zh' }
    expect(activeLocales(single)).toEqual(['zh'])
    expect(activeLocales(i18n)).toEqual(['en', 'zh'])
    writeInlangProject(single, singleRoot)
    const options = paraglideOptions(['/app', '/account'], singleRoot, false)
    expect(options.strategy).toEqual(['baseLocale'])
    expect(options.routeStrategies ?? []).toEqual([])
    await compile({ ...options, emitTsDeclarations: false })
    const runtime = await import(join(singleRoot, 'src/paraglide/runtime.js'))
    const { m } = await import(join(singleRoot, 'src/paraglide/messages.js'))
    const { paraglideMiddleware } = await import(join(singleRoot, 'src/paraglide/server.js'))
    expect(runtime.locales).toEqual(['zh'])
    expect(runtime.baseLocale).toBe('zh')
    expect(m.common_save()).toBe('保存')
    for (const path of ['/app', '/en/pricing', '/zh/pricing']) {
      const response = await paraglideMiddleware(
        new Request(`https://example.com${path}`, { headers: { cookie: 'PARAGLIDE_LOCALE=en' } }),
        () => new Response(runtime.getLocale()),
      )
      expect(await response.text()).toBe('zh')
      expect(response.headers.get('location')).toBeNull()
    }
  } finally {
    rmSync(singleRoot, { recursive: true, force: true })
  }
})

it('含大写字母的语言 id 编译为小写前缀，localize / deLocalize 与中间件一致（multilingual-seo 2.2）', async () => {
  const mixedRoot = mkdtempSync(join(tmpdir(), 'saas-i18n-mixed-'))
  try {
    symlinkSync(
      new URL('../node_modules', import.meta.url).pathname,
      join(mixedRoot, 'node_modules'),
    )
    const mixed = { locales: ['en', 'zh-Hant'], defaultLocale: 'en' }
    for (const [locale, text] of [
      ['en', 'Save'],
      ['zh-Hant', '儲存'],
    ] as const) {
      mkdirSync(join(mixedRoot, 'messages', locale), { recursive: true })
      writeFileSync(
        join(mixedRoot, 'messages', locale, 'common.json'),
        JSON.stringify({ common_save: text }),
      )
    }
    writeInlangProject(mixed, mixedRoot)
    const options = paraglideOptions(['/app'], mixedRoot, true, mixed)
    await compile({ ...options, emitTsDeclarations: false })
    const runtime = await import(join(mixedRoot, 'src/paraglide/runtime.js'))
    const { paraglideMiddleware } = await import(join(mixedRoot, 'src/paraglide/server.js'))
    const origin = 'https://example.com'
    const localize = (path: string, locale: string) =>
      runtime.localizeUrl(`${origin}${path}`, { locale }).pathname
    expect(localize('/pricing', 'zh-Hant')).toBe('/zh-hant/pricing')
    expect(localize('/', 'zh-Hant')).toBe('/zh-hant')
    expect(localize('/zh-hant/pricing', 'en')).toBe('/pricing')
    expect(runtime.deLocalizeUrl(`${origin}/zh-hant/pricing?x=1`).href).toBe(
      `${origin}/pricing?x=1`,
    )
    expect(runtime.extractLocaleFromUrl(`${origin}/zh-hant/pricing`)).toBe('zh-Hant')
    expect(runtime.extractLocaleFromUrl(`${origin}/pricing`)).toBe('en')
    // 请求头与 Cookie 不影响公开页语言，也不触发跳转
    for (const [path, locale, routed] of [
      ['/zh-hant/pricing', 'zh-Hant', '/pricing'],
      ['/zh-hant', 'zh-Hant', '/'],
      ['/pricing', 'en', '/pricing'],
    ] as const) {
      const response = await paraglideMiddleware(
        new Request(`${origin}${path}`, {
          headers: {
            'sec-fetch-dest': 'document',
            'accept-language': 'zh-TW',
            cookie: 'PARAGLIDE_LOCALE=zh-Hant',
          },
        }),
        ({ request }: { request: Request }) =>
          new Response(`${runtime.getLocale()} ${new URL(request.url).pathname}`),
      )
      expect(response.status, path).toBe(200)
      expect(response.headers.get('location')).toBeNull()
      expect(await response.text()).toBe(`${locale} ${routed}`)
    }
  } finally {
    rmSync(mixedRoot, { recursive: true, force: true })
  }
})

// 0.8.0 在位置参数末尾追加了 i18n，0.7.x 的三参数调用不再生成小写前缀规则；0.8.1 起各写法等价（升级说明 0.8.1）
describe('paraglideOptions 调用形式兼容（0.8.1）', () => {
  const mixed = { locales: ['en', 'zh-Hant'], defaultLocale: 'en' }
  let compatRoot: string
  beforeAll(() => {
    compatRoot = mkdtempSync(join(tmpdir(), 'saas-i18n-compat-'))
    writeInlangProject(mixed, compatRoot)
  })
  afterAll(() => rmSync(compatRoot, { recursive: true, force: true }))

  it('0.7.x 位置参数、0.8.0 追加 i18n 与语言配置在前三种写法结果相同', () => {
    const current = paraglideOptions(['/app'], compatRoot, true, mixed)
    expect(current.urlPatterns?.[0]?.localized).toContainEqual([
      'zh-Hant',
      ':protocol://:domain(.*)::port?/zh-hant/:path(.*)?',
    ])
    // 0.7.x：省略 i18n 时从 project.inlang/settings.json 读取语言
    expect(paraglideOptions(['/app'], compatRoot, true)).toEqual(current)
    expect(paraglideOptions(['/app'], compatRoot)).toEqual(current)
    expect(paraglideOptions(mixed, ['/app'], compatRoot)).toEqual(current)
  })

  it('关闭多语言时两种写法都只用 baseLocale', () => {
    const single = { ...mixed, enabled: false }
    const positional = paraglideOptions(['/app'], compatRoot, false)
    expect(positional.strategy).toEqual(['baseLocale'])
    expect(positional.urlPatterns).toBeUndefined()
    expect(paraglideOptions(single, ['/app'], compatRoot)).toEqual(positional)
  })
})

it('只编译启用插件的文案目录，关闭插件时 Paraglide 输出中没有其消息键（add-plugin-system 3.3）', async () => {
  const pluginRoot = mkdtempSync(join(tmpdir(), 'saas-i18n-plugin-'))
  try {
    const webRoot = join(pluginRoot, 'apps/web')
    const pluginMessages = join(pluginRoot, 'plugins/example/messages')
    mkdirSync(webRoot, { recursive: true })
    symlinkSync(new URL('../node_modules', import.meta.url).pathname, join(webRoot, 'node_modules'))
    for (const [dir, feature, messages] of [
      [
        join(webRoot, 'messages'),
        'common',
        { en: { common_save: 'Save' }, zh: { common_save: '保存' } },
      ],
      [pluginMessages, 'example', { en: { example_title: 'Example' }, zh: {} }],
    ] as const) {
      for (const [locale, values] of Object.entries(messages)) {
        mkdirSync(join(dir, locale), { recursive: true })
        writeFileSync(join(dir, locale, `${feature}.json`), JSON.stringify(values))
      }
    }
    // 启用：插件文案进入路径模式与缺失检查，编译后可用
    writeInlangProject(i18n, webRoot, [pluginMessages])
    expect(findMissingMessages(i18n, webRoot, [pluginMessages])).toEqual([
      { locale: 'zh', feature: 'example', key: 'example_title' },
    ])
    await compile({ ...paraglideOptions([], webRoot), emitTsDeclarations: false })
    const enabled = await import(`${join(webRoot, 'src/paraglide/messages.js')}?enabled`)
    expect(enabled.m.example_title?.({}, { locale: 'en' })).toBe('Example')
    // 关闭：重新生成后输出中没有插件的消息键
    rmSync(join(webRoot, 'src/paraglide'), { recursive: true, force: true })
    writeInlangProject(i18n, webRoot)
    await compile({ ...paraglideOptions([], webRoot), emitTsDeclarations: false })
    // 模块缓存会保留上一次的消息模块，这里直接检查编译输出的文本
    const output = readdirSync(join(webRoot, 'src/paraglide'), {
      recursive: true,
      encoding: 'utf8',
    })
      .filter((file) => file.endsWith('.js'))
      .map((file) => readFileSync(join(webRoot, 'src/paraglide', file), 'utf8'))
      .join('\n')
    expect(output).toContain('common_save')
    expect(output).not.toContain('example_title')
  } finally {
    rmSync(pluginRoot, { recursive: true, force: true })
  }
})
