import { z } from 'zod'
import type { TemplateConfig } from './template.ts'

// 构建期插件（openspec add-plugin-system 决策 2）：plugins/<id>/plugin.ts 用 definePlugin 声明静态清单，
// template.config.ts 的 `plugins` 段以 id 为键启用。清单只含可静态读取的数据与配置段 schema，
// 不导入运行时代码；校验在生成注册文件（scripts/plugins/generate.mjs）时执行，失败即构建失败。

export const PLUGIN_TARGETS = ['cloudflare', 'node'] as const
export type PluginTarget = (typeof PLUGIN_TARGETS)[number]

/** 清单可声明的 Cloudflare 绑定种类；名称与种类由一致性检查对照 wrangler 配置 */
export const PLUGIN_BINDING_KINDS = [
  'ai',
  'durable_object',
  'hyperdrive',
  'kv',
  'queue',
  'r2',
  'rate_limit',
  'service',
  'workflow',
] as const
export type PluginBindingKind = (typeof PLUGIN_BINDING_KINDS)[number]

export interface PluginBinding {
  readonly name: string
  readonly kind: PluginBindingKind
  /** durable_object / workflow 绑定指向的导出类名（必填），用于检查 wrangler 不引用未启用插件的类 */
  readonly className?: string
  /** 可选绑定：缺失时插件降级而不是报错（如 Workers AI） */
  readonly optional?: boolean
}

/** 插件校验读取的配置部分 */
export type PluginCheckConfig = Pick<
  TemplateConfig<string>,
  'plugins' | 'billing' | 'credits' | 'marketing' | 'i18n' | 'ai' | 'features'
>

/** 插件可要求开启的模板开关；值为从配置读取开关的函数 */
export const PLUGIN_FEATURES = {
  billing: (config) => config.billing.enabled,
  credits: (config) => config.credits.enabled,
  marketing: (config) => config.marketing.enabled,
  i18n: (config) => config.i18n.enabled,
  'ai.text': (config) => config.ai.text.enabled,
  'ai.image': (config) => config.ai.image,
  'ai.video': (config) => config.ai.video,
  publicApi: (config) => config.features.publicApi,
} as const satisfies Record<string, (config: PluginCheckConfig) => boolean>
export type PluginFeature = keyof typeof PLUGIN_FEATURES

/** 开关在 template.config.ts 中的写法，用于错误提示 */
const FEATURE_PATHS: Record<PluginFeature, string> = {
  billing: 'billing.enabled',
  credits: 'credits.enabled',
  marketing: 'marketing.enabled',
  i18n: 'i18n.enabled',
  'ai.text': 'ai.text.enabled',
  'ai.image': 'ai.image',
  'ai.video': 'ai.video',
  publicApi: 'features.publicApi',
}

export const PLUGIN_ENTRY_KINDS = ['web', 'worker', 'jobs', 'webNode', 'jobsNode'] as const
export type PluginEntryKind = (typeof PLUGIN_ENTRY_KINDS)[number]

/** 插件清单；路径均相对插件目录 */
export interface PluginManifest {
  /** 小写短横线 id，同时是 `plugins` 段的键与包名 `@saas/plugin-<id>` 的后缀 */
  readonly id: string
  readonly targets: readonly PluginTarget[]
  readonly requires?: {
    readonly plugins?: readonly string[]
    readonly features?: readonly PluginFeature[]
  }
  /** web 文件路由目录与挂载前缀；路由文件写完整路径，mount 一般为空串（根） */
  readonly routes?: { readonly dir: string; readonly mount: string }
  /**
   * web：导航、后台菜单、消息部件渲染器等（两目标共用）；worker：Cloudflare Worker 导出与 fetch 前置处理；
   * jobs：Cloudflare jobs 的 Workflow 类、队列、Cron 与积分预扣清理器；webNode / jobsNode：Node 目标对应入口。
   */
  readonly entries?: { readonly [K in PluginEntryKind]?: string }
  readonly bindings?: {
    readonly web?: readonly PluginBinding[]
    readonly jobs?: readonly PluginBinding[]
  }
  /** 所需密钥名称（生成器清单用） */
  readonly secrets?: readonly string[]
  /** 文案目录，结构同 apps/web/messages：<dir>/<locale>/<feature>.json */
  readonly messages?: string
  /** `plugins.<id>` 配置段的 schema；省略时配置段必须为空对象 */
  readonly config?: z.ZodType
}

/** 插件配置段：插件 schema 解析前的原始对象 */
export type PluginConfigSection = Readonly<Record<string, unknown>>

const ID = /^[a-z][a-z0-9-]*$/
const BINDING = /^[A-Z][A-Z0-9_]*$/
const CLASS_NAME = /^[A-Za-z_$][\w$]*$/

function relativePath(value: unknown) {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    !value.startsWith('/') &&
    !value.split(/[\\/]/).includes('..')
  )
}

/** 清单字段的结构问题；definePlugin 与生成器共用 */
export function pluginManifestIssues(manifest: PluginManifest): string[] {
  const issues: string[] = []
  const id = typeof manifest.id === 'string' ? manifest.id : '?'
  const at = (field: string, message: string) => issues.push(`plugin ${id}: ${field} ${message}`)
  if (!ID.test(id)) at('id', 'must be lowercase kebab-case')
  if (
    !Array.isArray(manifest.targets) ||
    manifest.targets.length === 0 ||
    !manifest.targets.every((target) => (PLUGIN_TARGETS as readonly string[]).includes(target))
  )
    at('targets', `must be a non-empty list of ${PLUGIN_TARGETS.join(' / ')}`)
  for (const dependency of manifest.requires?.plugins ?? [])
    if (!ID.test(dependency) || dependency === id)
      at('requires.plugins', `has an invalid plugin id ${JSON.stringify(dependency)}`)
  for (const feature of manifest.requires?.features ?? [])
    if (!Object.hasOwn(PLUGIN_FEATURES, feature))
      at(
        'requires.features',
        `has unknown feature ${JSON.stringify(feature)} (known: ${Object.keys(PLUGIN_FEATURES).join(', ')})`,
      )
  if (manifest.routes !== undefined) {
    if (!relativePath(manifest.routes.dir)) at('routes.dir', 'must be a relative path')
    if (typeof manifest.routes.mount !== 'string' || /^\/|\/$/.test(manifest.routes.mount))
      at('routes.mount', "must be '' or a path without leading/trailing slash")
  }
  for (const [kind, path] of Object.entries(manifest.entries ?? {})) {
    if (!(PLUGIN_ENTRY_KINDS as readonly string[]).includes(kind))
      at('entries', `has unknown entry ${kind}`)
    else if (!relativePath(path)) at(`entries.${kind}`, 'must be a relative path')
  }
  if (manifest.entries?.webNode !== undefined || manifest.entries?.jobsNode !== undefined)
    if (!manifest.targets?.includes('node'))
      at('entries', "declares Node entries but targets lacks 'node'")
  if (manifest.messages !== undefined && !relativePath(manifest.messages))
    at('messages', 'must be a relative path')
  for (const side of ['web', 'jobs'] as const) {
    const names = new Set<string>()
    for (const binding of manifest.bindings?.[side] ?? []) {
      const field = `bindings.${side}`
      if (!BINDING.test(binding.name))
        at(field, `has an invalid binding name ${JSON.stringify(binding.name)}`)
      if (names.has(binding.name)) at(field, `declares ${binding.name} more than once`)
      names.add(binding.name)
      if (!(PLUGIN_BINDING_KINDS as readonly string[]).includes(binding.kind))
        at(field, `${binding.name} has unknown kind ${JSON.stringify(binding.kind)}`)
      const classBound = binding.kind === 'durable_object' || binding.kind === 'workflow'
      if (classBound && !CLASS_NAME.test(binding.className ?? ''))
        at(field, `${binding.name} (${binding.kind}) requires className`)
      if (!classBound && binding.className !== undefined)
        at(field, `${binding.name} (${binding.kind}) must not set className`)
    }
  }
  for (const secret of manifest.secrets ?? [])
    if (!BINDING.test(secret)) at('secrets', `has an invalid secret name ${JSON.stringify(secret)}`)
  return issues
}

/** 插件清单（plugins/<id>/plugin.ts 的默认导出）；结构错误在加载清单时即抛出 */
export function definePlugin<const M extends PluginManifest>(manifest: M): M {
  const issues = pluginManifestIssues(manifest)
  if (issues.length > 0) throw new PluginConfigError(issues)
  return manifest
}

/** 插件配置错误：一次列出全部问题，便于一次改完 */
export class PluginConfigError extends RangeError {
  // 不用参数属性：scripts/plugins 以 Node 去类型方式直接加载本文件
  readonly issues: readonly string[]
  constructor(issues: readonly string[]) {
    super(`template config: invalid plugins\n${issues.map((issue) => `  - ${issue}`).join('\n')}`)
    this.name = 'PluginConfigError'
    this.issues = issues
  }
}

export interface ResolvedPlugin {
  readonly manifest: PluginManifest
  /** 经插件 schema 解析后的配置段 */
  readonly config: unknown
}

/**
 * 对照已有插件清单校验 `plugins` 段，按 id 排序返回启用的插件（输出确定）。
 * 校验：未知 id、配置段 schema、依赖插件、要求的模板开关；有 `media` 插件时 ai.image / ai.video 需启用它。
 */
export function resolvePlugins(
  config: PluginCheckConfig,
  manifests: readonly PluginManifest[],
): ResolvedPlugin[] {
  const issues: string[] = []
  const byId = new Map<string, PluginManifest>()
  for (const manifest of manifests) {
    issues.push(...pluginManifestIssues(manifest))
    if (byId.has(manifest.id))
      issues.push(`plugin ${manifest.id}: declared by more than one plugin.ts`)
    byId.set(manifest.id, manifest)
  }
  const available = [...byId.keys()].sort()
  const enabled = Object.keys(config.plugins).sort()
  const resolved: ResolvedPlugin[] = []
  for (const id of enabled) {
    const manifest = byId.get(id)
    if (!manifest) {
      issues.push(
        `plugins.${id}: unknown plugin (available: ${available.length > 0 ? available.join(', ') : 'none'})`,
      )
      continue
    }
    const section = config.plugins[id]
    let parsed: unknown = section
    if (manifest.config) {
      const result = manifest.config.safeParse(section)
      if (result.success) parsed = result.data
      else
        for (const issue of result.error.issues)
          issues.push(
            `plugins.${id}${issue.path.map((key) => `.${String(key)}`).join('')}: ${issue.message}`,
          )
    } else if (section && Object.keys(section).length > 0) {
      issues.push(`plugins.${id}: this plugin takes no options; use {}`)
    }
    for (const dependency of manifest.requires?.plugins ?? [])
      if (!Object.hasOwn(config.plugins, dependency))
        issues.push(`plugins.${id} requires plugin ${dependency}; add plugins.${dependency}`)
    for (const feature of manifest.requires?.features ?? [])
      if (Object.hasOwn(PLUGIN_FEATURES, feature) && !PLUGIN_FEATURES[feature](config))
        issues.push(`plugins.${id} requires ${FEATURE_PATHS[feature]} to be enabled`)
    resolved.push({ manifest, config: parsed })
  }
  // 媒体种类开关只在媒体插件存在时生效：迁移前的仓库没有 media 插件，不强制
  if (
    byId.has('media') &&
    (config.ai.image || config.ai.video) &&
    !Object.hasOwn(config.plugins, 'media')
  )
    issues.push('ai.image / ai.video require the media plugin; add plugins: { media: {} }')
  if (issues.length > 0) throw new PluginConfigError(issues)
  return resolved
}

/** 按部署目标划分：只支持其他目标的插件被排除（构建继续，调用方打印提示） */
export function pluginsForTarget<P extends { manifest: Pick<PluginManifest, 'targets'> }>(
  plugins: readonly P[],
  target: PluginTarget,
): { included: P[]; excluded: P[] } {
  const included: P[] = []
  const excluded: P[] = []
  for (const plugin of plugins)
    (plugin.manifest.targets.includes(target) ? included : excluded).push(plugin)
  return { included, excluded }
}

/** 运行时校验绑定形状时检查的方法（只检查形状，不读取取值）；hyperdrive 检查连接串 */
export const PLUGIN_BINDING_METHODS: Record<PluginBindingKind, readonly string[]> = {
  ai: ['run'],
  durable_object: ['idFromName', 'get'],
  hyperdrive: [],
  kv: ['get', 'put', 'delete'],
  queue: ['send'],
  r2: ['get', 'put', 'delete'],
  rate_limit: ['limit'],
  service: ['fetch'],
  workflow: ['create', 'get'],
}

function bindingSchema(kind: PluginBindingKind) {
  return z.custom<unknown>((value) => {
    if (typeof value !== 'object' || value === null) return false
    const record = value as Record<string, unknown>
    if (kind === 'hyperdrive') return typeof record.connectionString === 'string'
    return PLUGIN_BINDING_METHODS[kind].every((method) => typeof record[method] === 'function')
  })
}

/**
 * 启用插件声明的绑定的 zod 形状，供 web / jobs 的环境校验合并：必需绑定缺失或形状不对即启动校验失败，
 * 可选绑定只在存在时检查形状。
 */
export function pluginBindingsShape(
  bindings: readonly Pick<PluginBinding, 'name' | 'kind' | 'optional'>[],
): Record<string, z.ZodType> {
  return Object.fromEntries(
    bindings.map(({ name, kind, optional }) => [
      name,
      optional ? bindingSchema(kind).optional() : bindingSchema(kind),
    ]),
  )
}
