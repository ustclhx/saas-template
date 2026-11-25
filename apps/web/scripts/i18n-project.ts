// Paraglide 的 inlang 项目、编译选项与文案缺失检查（openspec add-marketing-i18n-seo tasks.md 1.1、1.3）。
//
// 文案按功能拆分为 messages/<locale>/<feature>.json（docs/09-parallel-plan.md §3 第 5 条）。
// project.inlang/settings.json 由这里按模板配置的 i18n 与现有文案文件生成（已 gitignore），
// 语言列表只在 template.config.ts 中维护。
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { type CompilerOptions, compile, paraglideVitePlugin } from '@inlang/paraglide-js'
import { EMAIL_LOCALES } from '@saas/email/queue'
import type { Plugin } from 'vite'
import { localeUrlPatterns } from '../src/features/i18n/locale-url.ts'

export interface I18nConfig {
  readonly enabled?: boolean
  readonly locales: readonly string[]
  readonly defaultLocale: string
}

export interface MissingMessage {
  readonly locale: string
  readonly feature: string
  readonly key: string
}

const WEB_ROOT = new URL('..', import.meta.url).pathname
// settings.json 中的相对路径以 project.inlang 的上级目录为基准；文案格式插件从本地加载，构建不依赖 CDN
const MESSAGE_FORMAT_PLUGIN = './node_modules/@inlang/plugin-message-format/dist/index.js'

/** messages/ 下所有语言目录中出现过的功能文件名（不含 .json）；messagesDir 默认为 `<root>/messages` */
export function listFeatures(root = WEB_ROOT, messagesDir = join(root, 'messages')): string[] {
  if (!existsSync(messagesDir)) return []
  const features = new Set<string>()
  for (const locale of readdirSync(messagesDir, { withFileTypes: true })) {
    if (!locale.isDirectory()) continue
    for (const file of readdirSync(join(messagesDir, locale.name))) {
      if (file.endsWith('.json')) features.add(file.slice(0, -'.json'.length))
    }
  }
  return [...features].sort()
}

/** 单语言仍复用 Paraglide 文案调用，只编译所选默认语言。 */
export function activeLocales(i18n: I18nConfig): readonly string[] {
  return i18n.enabled === false ? [i18n.defaultLocale] : i18n.locales
}

/**
 * 全部文案文件的路径模式（相对 root）：核心 messages/ 加上启用插件的文案目录（scripts/plugins 按目标给出，绝对路径）。
 * 未启用插件的目录不在列表中，其消息键不进入 Paraglide 输出。
 */
export function messagePathPatterns(
  root = WEB_ROOT,
  messageDirs: readonly string[] = [],
): string[] {
  const patterns = listFeatures(root).map((feature) => `./messages/{locale}/${feature}.json`)
  for (const dir of messageDirs) {
    const base = relative(root, dir).split(sep).join('/')
    const prefix = base.startsWith('.') ? base : `./${base}`
    for (const feature of listFeatures(root, dir))
      patterns.push(`${prefix}/{locale}/${feature}.json`)
  }
  return patterns
}

/** 写入 `<root>/project.inlang/settings.json`；内容未变化时不写，避免触发 Paraglide 重新编译 */
export function writeInlangProject(
  i18n: I18nConfig,
  root = WEB_ROOT,
  messageDirs: readonly string[] = [],
): void {
  const { defaultLocale } = i18n
  const locales = activeLocales(i18n)
  const settings = {
    $schema: 'https://inlang.com/schema/project-settings',
    baseLocale: defaultLocale,
    locales: [...locales],
    modules: [MESSAGE_FORMAT_PLUGIN],
    'plugin.inlang.messageFormat': {
      pathPattern: messagePathPatterns(root, messageDirs),
    },
  }
  const projectDir = join(root, 'project.inlang')
  const path = join(projectDir, 'settings.json')
  const content = `${JSON.stringify(settings, null, 2)}\n`
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(path, content)
}

/** `project.inlang/settings.json` 中的语言配置；文件不存在或无法解析时为 undefined */
function readInlangI18n(root: string): I18nConfig | undefined {
  try {
    const settings = JSON.parse(
      readFileSync(join(root, 'project.inlang/settings.json'), 'utf8'),
    ) as {
      baseLocale?: unknown
      locales?: unknown
    }
    const { baseLocale, locales } = settings
    return typeof baseLocale === 'string' &&
      Array.isArray(locales) &&
      locales.every((locale) => typeof locale === 'string')
      ? { locales, defaultLocale: baseLocale }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Paraglide 编译选项（design.md 决策 3）：公开页面按 URL 前缀确定语言（默认语言无前缀），
 * 其他配置语言 `/<locale>/...`；应用区不进入 URL，按 Cookie 取语言、没有时用默认语言。
 * 两者都不含 preferredLanguage，首次访问不会按浏览器语言自动跳转。
 * 前缀取语言 id 的小写形式（multilingual-seo 决策 2：`zh-Hant` → `/zh-hant`），
 * 大小写不同的写法与默认语言前缀由 request.server.ts 在进入 Paraglide 前 301。
 *
 * 两种调用形式（0.8.1 起都支持，衍生项目不必改调用处）：
 * - 位置参数 `paraglideOptions(appAreaPrefixes, root?, enabled?, i18n?)`：0.7.x 的三参数写法与 0.8.0 追加的 `i18n`；
 *   省略 `i18n` 时从 `<root>/project.inlang/settings.json`（writeInlangProject 生成）读取语言，
 *   保证 URL 规则与 301 规范化一致（否则 `zh-Hant` 的前缀会是 Paraglide 默认的 `/zh-Hant`，被 301 后无法识别）；
 * - 语言配置在前 `paraglideOptions(i18n, appAreaPrefixes, root?)`：多语言开关取 `i18n.enabled`。
 */
export function paraglideOptions(
  appAreaPrefixes: readonly string[],
  root?: string,
  enabled?: boolean,
  i18n?: I18nConfig,
): CompilerOptions
export function paraglideOptions(
  i18n: I18nConfig,
  appAreaPrefixes: readonly string[],
  root?: string,
): CompilerOptions
export function paraglideOptions(
  first: readonly string[] | I18nConfig,
  second?: string | readonly string[],
  third?: string | boolean,
  fourth?: I18nConfig,
): CompilerOptions {
  let appAreaPrefixes: readonly string[]
  let root: string
  let enabled: boolean
  let i18n: I18nConfig | undefined
  if (isI18nConfig(first)) {
    i18n = first
    appAreaPrefixes = Array.isArray(second) ? second : []
    root = typeof third === 'string' ? third : WEB_ROOT
    enabled = first.enabled !== false
  } else {
    appAreaPrefixes = first
    root = typeof second === 'string' ? second : WEB_ROOT
    enabled = typeof third === 'boolean' ? third : true
    i18n = fourth ?? (enabled ? readInlangI18n(root) : undefined)
  }
  return {
    project: join(root, 'project.inlang'),
    outdir: join(root, 'src/paraglide'),
    // tsconfig 未开启 allowJs，生成 .d.ts 供类型检查
    emitTsDeclarations: true,
    strategy: enabled ? ['url', 'baseLocale'] : ['baseLocale'],
    // 与路由器一致：去掉末尾的 `/`（否则 `/zh` 会被本地化为 `/zh/`，再被路由器 307 回来）
    trailingSlash: 'never',
    ...(enabled && i18n
      ? {
          urlPatterns: localeUrlPatterns({
            locales: activeLocales(i18n),
            defaultLocale: i18n.defaultLocale,
          }),
        }
      : {}),
    routeStrategies: (enabled ? [...appAreaPrefixes, '/_serverFn'] : []).map((prefix) => ({
      match: `${prefix}/:path(.*)?`,
      strategy: ['cookie', 'baseLocale'],
    })),
  }
}

function isI18nConfig(value: readonly string[] | I18nConfig): value is I18nConfig {
  return !Array.isArray(value)
}

function readKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set()
  const messages = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  return new Set(Object.keys(messages).filter((key) => key !== '$schema'))
}

/**
 * 以默认语言为准，列出其他语言缺失的文案。
 * 缺失的文案在运行时由 Paraglide 回退到默认语言（不会显示键名），这里只负责报告。
 */
export function findMissingMessages(
  { locales, defaultLocale }: I18nConfig,
  root = WEB_ROOT,
  messageDirs: readonly string[] = [],
): MissingMessage[] {
  const missing: MissingMessage[] = []
  for (const messagesDir of [join(root, 'messages'), ...messageDirs]) {
    for (const feature of listFeatures(root, messagesDir)) {
      const base = readKeys(join(messagesDir, defaultLocale, `${feature}.json`))
      for (const locale of locales) {
        if (locale === defaultLocale) continue
        const keys = readKeys(join(messagesDir, locale, `${feature}.json`))
        for (const key of base) if (!keys.has(key)) missing.push({ locale, feature, key })
      }
    }
  }
  return missing
}

/** 缺失项的日志文本；没有缺失时返回 null */
export function formatMissingMessages(missing: readonly MissingMessage[]): string | null {
  if (missing.length === 0) return null
  return [
    `[i18n] ${missing.length} 条文案缺少翻译，运行时回退到默认语言：`,
    ...missing.map(
      ({ locale, feature, key }) => `  - ${locale}: ${key} (messages/${locale}/${feature}.json)`,
    ),
  ].join('\n')
}

/**
 * Vite 插件：生成 inlang 项目后交给 Paraglide 编译；构建开始时在日志中列出缺失的文案。
 * `api.compile()` 供不经过 vite dev / build 的场景（typecheck 前生成 src/paraglide）使用。
 */
export function i18nMessages({
  i18n,
  appAreaPrefixes,
  messageDirs = [],
}: {
  readonly i18n: I18nConfig
  readonly appAreaPrefixes: readonly string[]
  /** 启用插件的文案目录（绝对路径） */
  readonly messageDirs?: readonly string[]
}): Plugin[] {
  const unsupported = activeLocales(i18n).filter(
    (locale) => !(EMAIL_LOCALES as readonly string[]).includes(locale),
  )
  if (unsupported.length) throw new Error(`[i18n] 邮件模板缺少语言：${unsupported.join(', ')}`)
  writeInlangProject(i18n, WEB_ROOT, messageDirs)
  const options = paraglideOptions(i18n, appAreaPrefixes)
  let reported = false
  return [
    paraglideVitePlugin(options) as Plugin,
    {
      name: 'saas:i18n-messages',
      api: { compile: () => compile(options) },
      // vite dev 的依赖扫描早于 Paraglide 插件在 buildStart 中的编译。冷启动（CI、新 worktree）时
      // src/paraglide 尚不存在，扫描因 @web/paraglide/... 等导入解析失败而跳过预打包，之后按请求
      // 逐个发现依赖并反复重载，启动可能逼近 e2e webServer 的超时。缺少生成目录时先编译一次。
      async config(_config, { command }) {
        if (command === 'serve' && !existsSync(join(options.outdir, 'runtime.js')))
          await compile(options)
      },
      buildStart() {
        // client 与 ssr 两个环境各触发一次 buildStart，只报告一次
        if (reported) return
        reported = true
        const report = formatMissingMessages(
          findMissingMessages({ ...i18n, locales: activeLocales(i18n) }, WEB_ROOT, messageDirs),
        )
        if (report) this.warn(report)
      },
    },
  ]
}
